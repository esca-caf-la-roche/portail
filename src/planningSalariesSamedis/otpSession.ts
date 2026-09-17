export const OTP_VALIDITY_MS = 10 * 60 * 1_000;
export const OTP_RESEND_DELAY_MS = 30 * 1_000;

const STORAGE_KEY = "planning-salaries-otp-pending";

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PendingOtp = {
  email: string;
  sentAt: number;
};

export function browserSessionStorage(): SessionStorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readPendingOtp(storage: SessionStorageLike | null, now = Date.now()): PendingOtp | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PendingOtp>;
    if (
      typeof parsed.email !== "string" ||
      parsed.email.trim() === "" ||
      typeof parsed.sentAt !== "number" ||
      !Number.isFinite(parsed.sentAt) ||
      parsed.sentAt > now ||
      now - parsed.sentAt >= OTP_VALIDITY_MS
    ) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }

    return { email: parsed.email.trim().toLowerCase(), sentAt: parsed.sentAt };
  } catch {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Le parcours reste utilisable même si le navigateur bloque le stockage.
    }
    return null;
  }
}

export function savePendingOtp(storage: SessionStorageLike | null, pending: PendingOtp) {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // Le stockage est une amélioration de continuité, pas un prérequis de connexion.
  }
}

export function clearPendingOtp(storage: SessionStorageLike | null) {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Le stockage peut être indisponible en navigation privée restrictive.
  }
}

export function remainingResendSeconds(sentAt: number, now = Date.now()) {
  return Math.max(0, Math.ceil((OTP_RESEND_DELAY_MS - (now - sentAt)) / 1_000));
}
