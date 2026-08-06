/**
 * NoteService — re-export shim.
 *
 * The implementation lives in `cli/src/core/NoteService.ts`; see the sibling
 * `PlanService.ts` shim for why. Add new note behaviour to the CLI module, not
 * here.
 */

export {
	archiveNoteForCommit,
	detectNotes,
	generateNoteSlug,
	getNotesDir,
	listUnassociatedNotes,
	removeNote,
	saveNote,
} from "../../../cli/src/core/NoteService.js";
