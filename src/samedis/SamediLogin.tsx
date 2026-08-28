import { useEffect, useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { KeyRound, Mail, Mountain } from "lucide-react";

export default function SamediLogin() {
  const { signIn } = useAuthActions();
  const [etape, setEtape] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [erreur, setErreur] = useState("");
  const [chargement, setChargement] = useState(false);
  const [attenteRenvoi, setAttenteRenvoi] = useState(0);

  useEffect(() => {
    if (attenteRenvoi <= 0) return;
    const timer = window.setInterval(() => setAttenteRenvoi((secondes) => Math.max(0, secondes - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [attenteRenvoi]);

  async function envoyerCode() {
    if (chargement || attenteRenvoi > 0) return;
    setErreur("");
    setChargement(true);
    try { await signIn("samedi-otp", { email: email.trim() }); }
    catch { /* Réponse identique pour toute adresse. */ }
    finally { setEtape("code"); setAttenteRenvoi(30); setChargement(false); }
  }

  async function demanderCode(event: FormEvent) {
    event.preventDefault();
    if (chargement) return;
    await envoyerCode();
  }

  async function verifierCode(event: FormEvent) {
    event.preventDefault();
    const codeNettoye = code.trim();
    if (!/^\d{6}$/.test(codeNettoye)) {
      setErreur("Saisissez les 6 chiffres du code reçu par e-mail.");
      return;
    }
    setErreur("");
    setChargement(true);
    try {
      await signIn("samedi-otp", { email: email.trim(), code: codeNettoye });
    } catch {
      setErreur("Code incorrect ou expiré. Utilisez le dernier code reçu.");
    } finally {
      setChargement(false);
    }
  }

  return (
    <main className="samedis-login">
      <section className="samedis-login-card" aria-labelledby="samedis-login-title">
        <div className="samedis-login-mark" aria-hidden="true"><Mountain /></div>
        <p className="samedis-kicker">Club d’escalade · réservation de salle</p>
        <h1 id="samedis-login-title">Carnet de réservation</h1>
        <p className="samedis-lead">Choisissez un samedi libre et retrouvez vos réservations de la salle en un coup d’œil.</p>

        {erreur && <div className="samedis-alert samedis-alert--error" role="alert"><KeyRound aria-hidden="true" /> {erreur}</div>}

        {etape === "email" ? (
          <form onSubmit={demanderCode} className="samedis-form">
            <label htmlFor="samedis-email">Adresse e-mail</label>
            <div className="samedis-input-icon"><Mail aria-hidden="true" /><input id="samedis-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="prenom.nom@exemple.fr" /></div>
            <p className="samedis-hint">Si cette adresse est autorisée, un code à 6 chiffres sera envoyé.</p>
            <button className="samedis-button samedis-button--primary" disabled={chargement}>{chargement ? "Envoi…" : "Recevoir mon code"}</button>
          </form>
        ) : (
          <form onSubmit={verifierCode} className="samedis-form">
            <label htmlFor="samedis-code">Code à 6 chiffres</label>
            <input id="samedis-code" className="samedis-code" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} placeholder="123456" />
            <p className="samedis-hint">Si cette adresse est autorisée, utilisez le code reçu par e-mail.</p>
            <button className="samedis-button samedis-button--primary" disabled={chargement}>{chargement ? "Vérification…" : "Ouvrir le calendrier"}</button>
            <button type="button" className="samedis-text-button" disabled={chargement || attenteRenvoi > 0} onClick={() => void envoyerCode()}>{attenteRenvoi > 0 ? `Renvoyer un code dans ${attenteRenvoi} s` : "Renvoyer un code"}</button>
            <button type="button" className="samedis-text-button" onClick={() => { setEtape("email"); setCode(""); setErreur(""); }}>Changer d’adresse e-mail</button>
          </form>
        )}
      </section>
    </main>
  );
}
