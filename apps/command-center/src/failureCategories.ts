export type ProductFailureCategory =
  | "model unavailable"
  | "invalid model decision"
  | "tool rejected"
  | "tool failed"
  | "verification failed"
  | "step budget exhausted"
  | "repeated action"
  | "permission denied"
  | "cancelled"
  | "conversation unavailable"
  | "internal runtime failure";

export function categorizeFailure(rawError?: unknown): ProductFailureCategory {
  if (!rawError) return "internal runtime failure";
  const message = (
    typeof rawError === "string"
      ? rawError
      : rawError instanceof Error
        ? rawError.message
        : typeof (rawError as { message?: unknown })?.message === "string"
          ? (rawError as { message: string }).message
          : String(rawError)
  ).toLowerCase();

  if (message.includes("cancel")) return "cancelled";
  if (message.includes("repeated the same action without progress") || message.includes("stopped after repeating")) return "repeated action";
  if (message.includes("specialist conversation")) return "conversation unavailable";
  if (
    message.includes("budget") ||
    message.includes("decision limit") ||
    message.includes("max steps") ||
    message.includes("step limit")
  ) {
    return "step budget exhausted";
  }
  if (message.includes("verif")) {
    return "verification failed";
  }
  if (
    message.includes("permission") ||
    message.includes("eacces") ||
    message.includes("access denied")
  ) {
    return "permission denied";
  }
  if (
    message.includes("must read a file before modifying") ||
    message.includes("not read a file before modifying") ||
    message.includes("cannot modify") ||
    message.includes("rejected") ||
    message.includes("invalid target")
  ) {
    return "tool rejected";
  }
  if (
    message.includes("tool execution") ||
    message.includes("tool failed") ||
    message.includes("tool operation failed") ||
    message.includes("could not complete")
  ) {
    return "tool failed";
  }
  if (
    message.includes("decision") ||
    message.includes("malformed") ||
    message.includes("structured-parse") ||
    message.includes("reasoning block") ||
    message.includes("incomplete reasoning") ||
    message.includes("json") ||
    message.includes("insufficient-evidence")
  ) {
    return "invalid model decision";
  }
  if (
    message.includes("model") ||
    message.includes("not configured") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("authentication") ||
    message.includes("capacity") ||
    message.includes("transport")
  ) {
    return "model unavailable";
  }
  return "internal runtime failure";
}
