import { useEffect, useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { KeyRound, Mail, Route } from "lucide-react";

export default function PlanningSalariesLogin() {
  const { signIn } = useAuthActions();
  const [etape, setEtape] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [erreur, setErreur] = useState("");
  const [chargement, setChargement] = useState(false);
  const [attente, setAttente] = useState(0);

  useEffect(() => {
    if (attente <= 0) return;
    const timer = window.setInterval(() => setAttente((valeur) => Math.max(0, valeur - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [attente]);

  async function envoyerCode() {
    if (chargement || attente > 0) return;
    setErreur("");
    setChargement(true);
    try {
      await signIn("planning-salaries-otp", { email: email.trim() });
    } catch {
      // Réponse volontairement identique pour ne pas révéler l'annuaire.
    } finally {
      setEtape("code");
      setAttente(30);
      setChargement(false);
    }
  }

  async function demanderCode(event: FormEvent) {
    event.preventDefault();
    await envoyerCode();
  }

  async function verifierCode(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setErreur("Saisissez les 6 chiffres du code reçu par e-mail.");
      return;
    }
    setChargement(true);
    setErreur("");
    try {
      await signIn("planning-salaries-otp", { email: email.trim(), code: code.trim() });
    } catch {
      setErreur("Code incorrect ou expiré. Utilisez le dernier code reçu.");
    } finally {
      setChargement(false);
    }
  }

  return (
    <main className="pss-login">
      <section className="pss-login-card" aria-labelledby="pss-login-title">
        <div className="pss-login-mark" aria-hidden="true"><Route /></div>
        <p className="pss-kicker">Équipe salariée · relais du samedi</p>
        <h1 id="pss-login-title">Prendre le relais</h1>
        <p className="pss-lead">Consultez les groupes et choisissez les samedis que vous prenez en charge.</p>
        {erreur && <div className="pss-alert pss-alert--error" role="alert"><KeyRound aria-hidden="true" />{erreur}</div>}
        {etape === "email" ? (
          <form className="pss-form" onSubmit={demanderCode}>
            <label htmlFor="pss-email">Adresse e-mail professionnelle</label>
            <div className="pss-input-icon"><Mail aria-hidden="true" /><input id="pss-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
            <p className="pss-hint">Si cette adresse figure dans l’annuaire, elle recevra un code à 6 chiffres.</p>
            <button className="pss-button pss-button--primary" disabled={chargement}>{chargement ? "Envoi…" : "Recevoir mon code"}</button>
          </form>
        ) : (
          <form className="pss-form" onSubmit={verifierCode}>
            <label htmlFor="pss-code">Code à 6 chiffres</label>
            <input id="pss-code" className="pss-code" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} />
            <button className="pss-button pss-button--primary" disabled={chargement}>{chargement ? "Vérification…" : "Ouvrir le planning"}</button>
            <button type="button" className="pss-text-button" disabled={chargement || attente > 0} onClick={() => void envoyerCode()}>{attente > 0 ? `Renvoyer dans ${attente} s` : "Renvoyer un code"}</button>
            <button type="button" className="pss-text-button" onClick={() => { setEtape("email"); setCode(""); setErreur(""); }}>Changer d’adresse</button>
          </form>
        )}
      </section>
    </main>
  );
}
