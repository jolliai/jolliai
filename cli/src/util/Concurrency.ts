/**
 * Bounded-concurrency fan-out, and the process-wide I/O budget every fan-out
 * draws on.
 *
 * ## Two separate things, deliberately not merged
 *
 * {@link mapWithConcurrency} SHAPES a fan-out: how many of one call site's items
 * are in flight at once. {@link withIoBudget} GATES the actual I/O: how much is
 * in flight across the whole process, no matter how many call sites are running.
 *
 * They are separate because they answer different questions and because merging
 * them cannot work. A fan-out does not know how many bytes its `fn` is about to
 * materialise — only the code doing the read knows that — and a budget cannot
 * know how to shape someone else's item list. So the discipline is: shape with
 * the fan-out, and wrap each LEAF read in the budget.
 *
 * ## Why a shared budget at all
 *
 * Because the alternative is a constant per call site, and those multiply
 * silently. The session scan already fans out across twelve agent stores; giving
 * each one its own width of 8 would put 96 reads in flight with nothing able to
 * report the total. Past the process limit on open descriptors (256 by default
 * on macOS) reads start failing with `EMFILE`, and they fail as rejected
 * promises inside a fan-out, so the whole batch rejects rather than degrading.
 *
 * The budget also stops the opposite waste, which is the common case in
 * practice: sessions concentrate in one or two agents, so most stores answer
 * with an empty `readdir` and consume nothing. A per-site constant leaves the
 * one store that HAS the work capped at its own small share while eleven idle
 * shares go unused. One pool means the busy site gets all of it.
 */

/**
 * Slots in the shared budget: how many I/O operations may be in flight process-wide.
 *
 * Comfortably below every platform's descriptor limit, with room for the file
 * handles the rest of the process holds. It is the default width of every
 * fan-out for a reason — see {@link mapWithConcurrency}.
 */
const DEFAULT_IO_SLOTS = 8;

/**
 * Bytes the budget will let call sites materialise at once — the second, independent
 * dimension, and the one a slot count cannot express.
 *
 * A slot count treats every read as the same size, and transcripts are not: eight
 * concurrent reads is nothing at the measured 0.9 MB median and several hundred
 * megabytes if a user happens to have eight very long conversations, because a file
 * being parsed exists two or three times over (the UTF-16 string, the split lines,
 * the parsed objects). Claiming bytes as well as a slot makes the peak a property of
 * this constant instead of a property of whatever the user's largest conversation
 * happens to be: many small reads still fill every slot, one huge read quietly runs
 * alone.
 */
const DEFAULT_BYTES_IN_FLIGHT = 64 * 1024 * 1024;

interface Waiter {
	/**
	 * What the caller ASKED for, unclamped — the clamp against the cap is applied at
	 * grant time, not here.
	 *
	 * Storing the clamped value would freeze it against the cap in force when the
	 * caller queued, and {@link IoBudget.configure} can lower that cap afterwards: the
	 * head of the queue would then hold a claim larger than the whole budget, never
	 * fit, and stall every I/O in the process with no error and no timeout. Clamping on
	 * the way out means a shrink re-clamps whoever is still waiting.
	 */
	readonly want: number;
	/** Resumes the caller, handing back the byte allowance actually taken. */
	readonly wake: (granted: number) => void;
}

/**
 * The shared gate. Grants a slot, and optionally a byte allowance, to one
 * operation at a time in arrival order.
 *
 * Strict FIFO: only the queue HEAD is considered, even when a later, smaller
 * waiter would fit. Letting small requests overtake would starve a large one
 * indefinitely on a busy scan — the read this exists to bound is exactly the one
 * that would never run.
 */
class IoBudget {
	private slots = DEFAULT_IO_SLOTS;
	private bytesCap = DEFAULT_BYTES_IN_FLIGHT;
	private slotsInUse = 0;
	private bytesInUse = 0;
	private readonly waiting: Waiter[] = [];

	/** Current slot count — the default width of every fan-out. */
	get width(): number {
		return this.slots;
	}

	/**
	 * Resizes the budget. Intended for a HOST that must be gentler than a one-shot
	 * command — the CLI's dashboard back-fill owns its whole process and wants the
	 * default, while a long-lived editor host runs this on a timer alongside
	 * everything else the user is doing.
	 *
	 * No host narrows it today; the VS Code extension and the IntelliJ bridge both
	 * inherit the default. Stated rather than implied, because "there is a knob"
	 * and "someone turned it" are different facts.
	 *
	 * Raising the limits pumps the queue immediately, so callers already waiting
	 * benefit rather than sitting until the next release. Lowering them is safe for the
	 * same reason the other direction is: a waiter's claim is clamped when it is
	 * granted, never when it is queued — see {@link Waiter.want}.
	 */
	configure(opts: { readonly slots?: number; readonly bytesInFlight?: number }): void {
		if (opts.slots !== undefined) this.slots = Math.max(1, Math.floor(opts.slots));
		if (opts.bytesInFlight !== undefined) this.bytesCap = Math.max(0, Math.floor(opts.bytesInFlight));
		this.pump();
	}

	/** Restores the shipped defaults. Test seam. */
	reset(): void {
		this.slots = DEFAULT_IO_SLOTS;
		this.bytesCap = DEFAULT_BYTES_IN_FLIGHT;
		this.pump();
	}

	/**
	 * Runs `fn` holding one slot and `bytes` of the byte allowance.
	 *
	 * `bytes` is CLAMPED to the whole cap, which is what keeps a file larger than
	 * the entire byte budget runnable: it waits until nothing else is in flight and
	 * then proceeds alone. Without the clamp such a read could never fit and would
	 * wait forever.
	 *
	 * NEVER NEST. An inner call waits for a slot while the outer one holds it, so
	 * enough nested callers deadlock the pool with no error and no timeout. Wrap the
	 * leaf read — the one that opens a handle and materialises bytes — and nothing
	 * above it.
	 */
	async run<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
		// The amount RELEASED is the amount the gate says it granted, never a
		// recomputation of it: the clamp reads `bytesCap`, and a `configure` call while
		// this operation runs would otherwise release a different number than was taken
		// and leave the accounting permanently off.
		const granted = await this.acquire(Math.max(0, bytes));
		try {
			return await fn();
		} finally {
			this.slotsInUse--;
			this.bytesInUse -= granted;
			this.pump();
		}
	}

	/** The share of the byte allowance a request for `want` bytes actually takes. */
	private clamp(want: number): number {
		return Math.min(want, this.bytesCap);
	}

	/** True when a request for `want` bytes can be granted right now. */
	private fits(want: number): boolean {
		return this.slotsInUse < this.slots && this.bytesInUse + this.clamp(want) <= this.bytesCap;
	}

	/** Resolves with the byte allowance taken, which the caller must release verbatim. */
	private acquire(want: number): Promise<number> {
		// Queue even when the claim would fit, if anyone is already waiting: jumping
		// the queue here is the same starvation the FIFO rule exists to prevent.
		if (this.waiting.length === 0 && this.fits(want)) return Promise.resolve(this.take(want));
		return new Promise<number>((wake) => {
			this.waiting.push({ want, wake });
		});
	}

	/** Books one slot and the clamped byte allowance, returning what was booked. */
	private take(want: number): number {
		const claim = this.clamp(want);
		this.slotsInUse++;
		this.bytesInUse += claim;
		return claim;
	}

	/**
	 * Grants what the freed capacity allows, accounting for each grant BEFORE waking
	 * its waiter. The accounting cannot be left to the woken caller: it resumes in a
	 * later microtask, by which point this loop would have granted the same capacity
	 * to everyone behind it.
	 */
	private pump(): void {
		while (this.waiting.length > 0 && this.fits(this.waiting[0].want)) {
			const next = this.waiting.shift() as Waiter;
			next.wake(this.take(next.want));
		}
	}
}

/** The process-wide budget. One per process is the point — see the module header. */
export const ioBudget = new IoBudget();

/**
 * Runs `fn` under the shared I/O budget, claiming one slot and `bytes` of the
 * byte allowance.
 *
 * Pass the number of bytes `fn` will actually materialise, not the file's size:
 * a 64 KB tail read of a 50 MB file claims 64 KB. Over-claiming is not merely
 * pessimistic, it makes one cheap read hold the allowance a genuinely large read
 * needs. Pass 0 for an operation that opens something without reading it whole
 * (a SQLite query, a first-line read) — it still takes a slot, which is what
 * bounds the descriptor count.
 *
 * See {@link IoBudget.run} for the no-nesting rule, which is load-bearing.
 */
export function withIoBudget<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
	return ioBudget.run(bytes, fn);
}

/**
 * Default fan-out width: the budget's own slot count.
 *
 * Deliberately not a smaller, "polite" number. A fan-out narrower than the pool
 * caps a call site below what the pool would give it, and on a real machine most
 * stores are empty — so the one site with work to do would be throttled while the
 * pool sat idle. The pool is what enforces the total; the fan-out only has to be
 * wide enough not to leave it unused.
 */
export function defaultConcurrency(): number {
	return ioBudget.width;
}

/**
 * Maps `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the result.
 *
 * Order preservation is load-bearing rather than cosmetic: callers pair the
 * result with the input array by index, and a completion-ordered result would
 * silently mis-pair every entry.
 *
 * This shapes the fan-out; it does NOT gate I/O. An `fn` that reads files should
 * wrap that read in {@link withIoBudget}, which is what keeps the process-wide
 * total bounded when several call sites fan out at once. A fan-out whose `fn`
 * skips the budget is unbounded in aggregate no matter what `limit` says.
 *
 * `fn` is expected to handle its own failures — a rejection propagates and
 * abandons the remaining items, which is the right behaviour for a genuine
 * programming error and the wrong one for "this file happened to be unreadable".
 * Scanners therefore catch per item and return a sentinel.
 */
export async function mapWithConcurrency<T, R>(
	items: ReadonlyArray<T>,
	fn: (item: T, index: number) => Promise<R>,
	limit: number = defaultConcurrency(),
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: width }, async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			out[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return out;
}
