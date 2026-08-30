import { formatSystemTurnPrompt } from "../sessions/system-turn-prompt.js";
import { truncateUtf16Safe } from "../utils.js";
import { TOOL_FAILURE_INSTRUCTION } from "./tool-outcome-instructions.js";

const RESUME_TASK_MAX_LENGTH = 2_000;

/**
 * Fixed resume prompt for the main session: no task context, just tells the
 * model to keep going from the existing transcript.
 */
export function buildMainSessionGatewayRestartResumePrompt(): string {
  return formatSystemTurnPrompt(
    "Your previous turn was interrupted by a gateway restart while " +
      "OpenClaw was waiting on tool/model work. Continue from the existing " +
      "transcript and finish the interrupted response. Treat a tool result marked interrupted or " +
      `missing as having an unknown outcome. ${TOOL_FAILURE_INSTRUCTION}`,
  );
}

/**
 * Resume prompt for a subagent, carrying the original task (and, if present,
 * the last human message) so the resumed run has the context it lost.
 */
export function buildGatewayRestartResumePrompt(task: string, lastHumanMessage?: string): string {
  const original =
    task.length > RESUME_TASK_MAX_LENGTH
      ? `${truncateUtf16Safe(task, RESUME_TASK_MAX_LENGTH)}...`
      : task;
  return formatSystemTurnPrompt(
    `Your previous turn was interrupted by a gateway restart. ` +
      `Your original task was:\n\n${original}\n\n` +
      (lastHumanMessage
        ? `The last message from the user before the interruption was:\n\n${lastHumanMessage}\n\n`
        : "") +
      `Please continue where you left off.`,
  );
}

/**
 * Terminal-failure error string for a subagent run that never recovered
 * after repeated automatic retry attempts.
 */
export function buildGatewayRestartRecoveryFailureError(attempts: number, detail?: string): string {
  const trimmedDetail = detail?.trim();
  return (
    `Subagent run was interrupted by a gateway restart or connection loss. ` +
    `Automatic recovery failed after ${attempts} attempts. Please retry.` +
    (trimmedDetail ? ` (${trimmedDetail})` : "")
  );
}
