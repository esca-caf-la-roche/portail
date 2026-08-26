"use node";

import { internalAction as action } from "./_generated/server";
import { v } from "convex/values";
import { SMTPClient } from "emailjs";
import { canoniserEmailUnique } from "./emailValidation";

export const AVERTISSEMENT_REPONSE_EMAIL_ABO =
  "Merci de ne pas répondre à cet e-mail : votre réponse ne sera pas prise en compte. " +
  "Pour nous contacter, utilisez la messagerie du site.";

export function ajouterAvertissementReponseEmailAbo(texte: string): string {
  if (texte.includes(AVERTISSEMENT_REPONSE_EMAIL_ABO)) return texte;
  return `${texte.trimEnd()}\n\n${AVERTISSEMENT_REPONSE_EMAIL_ABO}`;
}

function creerTransporteur(email: string, motDePasse: string) {
  return new SMTPClient({
    user: email,
    password: motDePasse,
    host: "smtp.gmail.com",
    ssl: true,
  });
}

export function construirePiecesEmail(
  pieceJointe?: { nom: string; contenuBase64: string; type: string },
  html?: string,
) {
  return [
    ...(html
      ? [{
          data: html,
          alternative: true,
          type: "text/html",
          charset: "utf-8",
        }]
      : []),
    ...(pieceJointe
      ? [{
          name: pieceJointe.nom,
          data: pieceJointe.contenuBase64,
          // emailjs attend une chaîne déjà encodée lorsque `encoded` vaut true.
          encoded: true,
          type: pieceJointe.type,
        }]
      : []),
  ];
}

async function envoyerEmail(
  compteSmtp: string,
  motDePasse: string,
  expediteur: string,
  destinataire: string,
  sujet: string,
  texte: string,
  pieceJointe?: { nom: string; contenuBase64: string; type: string },
  html?: string,
) {
  const client = creerTransporteur(compteSmtp, motDePasse);
  try {
    const pieces = construirePiecesEmail(pieceJointe, html);
    await client.sendAsync({
      from: expediteur,
      to: destinataire,
      subject: sujet,
      text: texte,
      ...(pieces.length > 0 ? { attachment: pieces } : {}),
    });
  } finally {
    client.smtp.close();
  }
}

export const sendOTP = action({
  args: { email: v.string(), code: v.string() },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const destinataire = canoniserEmailUnique(args.email);
    try {
      const senderEmail = process.env.EMAIL_SENDER;
      const senderPassword = process.env.EMAIL_PASSWORD;

      if (!senderEmail || !senderPassword) {
        console.warn("[GoogleOTP] Configuration SMTP indisponible.");
        throw new Error("L'envoi du code de connexion est temporairement indisponible. Réessayez plus tard.");
      }

      const subject = `${args.code} : votre code de connexion au portail escalade`;
      const body = `Bonjour,\n\nVotre code de vérification est : ${args.code}\n\nCe code expirera dans 10 minutes.\n\nL'équipe du Portail Escalade CAF LRB.`;

      await envoyerEmail(
        senderEmail,
        senderPassword,
        `Portail Escalade CAF LRB <${senderEmail}>`,
        destinataire,
        subject,
        body,
      );
      
      console.info("[GoogleOTP] E-mail d'authentification envoyé.");
      return null;
    } catch {
      console.error("[GoogleOTP] Échec de l'envoi SMTP.");
      throw new Error("L'envoi du code de connexion est temporairement indisponible. Réessayez plus tard.");
    }
  }
});

// Envoi générique d'un email du module Abonnements, via une boîte mail DISTINCTE
// de l'OTP compta (abonnementSAE@… du club). Sert à l'OTP abonnés publics et aux
// emails transactionnels (validation, liste d'attente, refus, messagerie).
// Secrets Convex : EMAIL_SENDER_ABO / EMAIL_PASSWORD_ABO (mot de passe d'appli).
export const sendAboEmail = action({
  args: {
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    pieceJointe: v.optional(
      v.object({
        nom: v.string(),
        contenuBase64: v.string(),
        type: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const destinataire = canoniserEmailUnique(args.to);
    try {
      const senderEmail = process.env.EMAIL_SENDER_ABO;
      const senderPassword = process.env.EMAIL_PASSWORD_ABO;

      if (!senderEmail || !senderPassword) {
        console.warn("[Abo] Configuration SMTP indisponible.");
        throw new Error("L'envoi de l'e-mail est temporairement indisponible. Réessayez plus tard.");
      }

      await envoyerEmail(
        senderEmail,
        senderPassword,
        `Abonnements Escalade CAF <${senderEmail}>`,
        destinataire,
        args.subject,
        ajouterAvertissementReponseEmailAbo(args.text),
        args.pieceJointe,
      );

      console.info("[Abo] E-mail transactionnel envoyé.");
      return null;
    } catch {
      console.error("[Abo] Échec de l'envoi SMTP.");
      throw new Error("L'envoi de l'e-mail est temporairement indisponible. Réessayez plus tard.");
    }
  },
});

// Envoi dédié à la tuile Samedis. Les mêmes secrets que le portail staff sont
// utilisés, sans exposer un endpoint public d'envoi arbitraire.
export const sendSamediEmail = action({
  args: {
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const destinataire = canoniserEmailUnique(args.to);
    const senderEmail = process.env.EMAIL_SENDER;
    const senderPassword = process.env.EMAIL_PASSWORD;
    if (!senderEmail || !senderPassword) {
      console.warn("[Samedis] Configuration SMTP indisponible.");
      throw new Error("L'envoi de l'e-mail Samedis est temporairement indisponible.");
    }
    try {
      await envoyerEmail(
        senderEmail,
        senderPassword,
        `Samedis Escalade CAF LRB <${senderEmail}>`,
        destinataire,
        args.subject,
        args.text,
        undefined,
        args.html,
      );
      return null;
    } catch {
      console.error("[Samedis] Échec de l'envoi SMTP.");
      throw new Error("L'envoi de l'e-mail Samedis est temporairement indisponible.");
    }
  },
});

// Envoi dédié au planning des salariés du samedi. Il réutilise la boîte du
// portail staff, comme la tuile Samedis, sans exposer d'endpoint arbitraire.
export const sendPlanningSalariesEmail = action({
  args: {
    to: v.string(),
    bcc: v.array(v.string()),
    subject: v.string(),
    text: v.string(),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const senderEmail = process.env.EMAIL_SENDER;
    const senderPassword = process.env.EMAIL_PASSWORD;
    if (!senderEmail || !senderPassword) {
      throw new Error("La configuration SMTP du planning des samedis est absente.");
    }
    const destinataire = canoniserEmailUnique(args.to);
    const bcc = [...new Set(args.bcc.map(canoniserEmailUnique))]
      .filter((email) => email !== destinataire);
    const client = creerTransporteur(senderEmail, senderPassword);
    try {
      await client.sendAsync({
        from: `Escalade CAF La Roche-Bonneville <${senderEmail}>`,
        to: destinataire,
        ...(bcc.length > 0 ? { bcc: bcc.join(", ") } : {}),
        subject: args.subject,
        text: args.text,
      });
      return null;
    } finally {
      client.smtp.close();
    }
  },
});
