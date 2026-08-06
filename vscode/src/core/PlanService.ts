/**
 * PlanService — re-export shim.
 *
 * The implementation lives in `cli/src/core/PlanService.ts` so that both IDE
 * hosts run the same plan rules: this extension bundles `cli/src/**` and calls
 * it in-process, while IntelliJ reaches the identical functions over
 * `jolli ide-bridge`. Keeping the shim means every existing
 * `import … from "./core/PlanService.js"` in this workspace keeps working.
 *
 * Add new plan behaviour to the CLI module, never here — a function that exists
 * only in this file is invisible to IntelliJ and re-opens the drift this shim
 * was introduced to close.
 */

export {
	addPlanToRegistry,
	archivePlanForCommit,
	detectPlans,
	extractTitle,
	getPlansDir,
	isPlanFromCurrentProject,
	listAvailablePlans,
	listUnassociatedPlans,
	registerNewPlan,
	removePlan,
	renamePlanTitle,
} from "../../../cli/src/core/PlanService.js";
