/**
 * SidebarEmptyMessages
 *
 * Empty/disabled-state strings shown by the sidebar webview client.
 * Injected into the page as a JSON <script> block so the webview JS can
 * read them at boot. This is the single source of truth — the strings
 * were previously scattered across `viewsWelcome` entries in package.json,
 * which was deleted in Task 6 when the 5 tree views were replaced with
 * a single webview view.
 */

export const SIDEBAR_EMPTY_STRINGS = {
	disabled: "Jolli Memory is disabled.",
	enableButton: "Enable Jolli Memory",
	kbFoldersEmpty: "No files yet.",
	kbMemoriesEmpty: "No memories yet.",
	noBranch: "(no branch)",
	notInGit: "This workspace is not a git repository.",
	plansEmpty: "No plans or notes yet. Click + to add a plan or note.",
	changesEmpty: "No changes.",
	commitsEmpty: "Start coding — your commit memories will appear here.",
	failedLoad: "Failed to load. Click refresh to retry.",
} as const;

export type SidebarEmptyStrings = typeof SIDEBAR_EMPTY_STRINGS;
