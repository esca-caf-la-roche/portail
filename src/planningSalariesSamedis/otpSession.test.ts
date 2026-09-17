import { describe, expect, it } from "vitest";
import {
  OTP_VALIDITY_MS,
  clearPendingOtp,
  readPendingOtp,
  remainingResendSeconds,
  savePendingOtp,
} from "./otpSession";

function storageFixture() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    rawValues: values,
  };
}

describe("planning salaries OTP session", () => {
  it("restaure une demande encore valide sans stocker de code", () => {
    const storage = storageFixture();
    savePendingOtp(storage, { email: " Salarie@Example.org ", sentAt: 10_000 });

    expect(readPendingOtp(storage, 20_000)).toEqual({
      email: "salarie@example.org",
      sentAt: 10_000,
    });
    expect([...storage.rawValues.values()]).toEqual([
      JSON.stringify({ email: " Salarie@Example.org ", sentAt: 10_000 }),
    ]);
    expect([...storage.rawValues.values()].join()).not.toContain("code");
    expect(remainingResendSeconds(10_000, 20_000)).toBe(20);
  });

  it("supprime une demande expiree ou invalide", () => {
    const storage = storageFixture();
    savePendingOtp(storage, { email: "salarie@example.org", sentAt: 10_000 });

    expect(readPendingOtp(storage, 10_000 + OTP_VALIDITY_MS)).toBeNull();
    expect(readPendingOtp(storage, 10_000 + OTP_VALIDITY_MS + 1)).toBeNull();

    clearPendingOtp(storage);
    expect(readPendingOtp(storage, 20_000)).toBeNull();
  });

  it("ignore un stockage indisponible ou qui leve une erreur", () => {
    const throwingStorage = {
      getItem: () => { throw new DOMException("blocked", "SecurityError"); },
      setItem: () => { throw new DOMException("blocked", "SecurityError"); },
      removeItem: () => { throw new DOMException("blocked", "SecurityError"); },
    };

    expect(readPendingOtp(null, 20_000)).toBeNull();
    expect(readPendingOtp(throwingStorage, 20_000)).toBeNull();
    expect(() => savePendingOtp(throwingStorage, { email: "a@example.org", sentAt: 10_000 })).not.toThrow();
    expect(() => clearPendingOtp(throwingStorage)).not.toThrow();
  });

  it.each([
    ["JSON malforme", "{"],
    ["forme invalide", JSON.stringify({ email: "", sentAt: "hier" })],
    ["date future", JSON.stringify({ email: "a@example.org", sentAt: 20_001 })],
  ])("supprime une session avec %s", (_cas, valeur) => {
    const storage = storageFixture();
    storage.setItem("planning-salaries-otp-pending", valeur);

    expect(readPendingOtp(storage, 20_000)).toBeNull();
    expect(storage.rawValues.size).toBe(0);
  });
});
