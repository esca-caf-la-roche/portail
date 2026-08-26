export function planningError(error: unknown): string {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "L’opération n’a pas abouti. Réessayez dans quelques instants.";
}
