// @vitest-environment node
import { Message } from "emailjs";
import { expect, test } from "vitest";
import { construirePiecesEmail } from "./email";

test("assemble le fallback texte et le HTML en multipart/alternative", async () => {
  const html = "<html><body>Version HTML</body></html>";
  const message = new Message({
    from: "escalade@example.test",
    to: "club@example.test",
    subject: "Notification Samedis",
    text: "Version texte de secours",
    attachment: construirePiecesEmail(undefined, html),
  });

  const contenu = await message.readAsync();
  expect(contenu).toContain("multipart/alternative");
  expect(contenu).toContain("Content-Type:text/plain");
  expect(contenu).toContain("Content-Type: text/html");
  expect(contenu).toContain("Version texte de secours");
  expect(contenu).toContain(Buffer.from(html).toString("base64"));
});

test("conserve une pièce jointe lorsque le HTML est présent", () => {
  const pieces = construirePiecesEmail(
    {
      nom: "document.pdf",
      contenuBase64: "ZmljaGllcg==",
      type: "application/pdf",
    },
    "<strong>HTML</strong>",
  );

  expect(pieces).toHaveLength(2);
  expect(pieces[0]).toMatchObject({ alternative: true, type: "text/html" });
  expect(pieces[1]).toMatchObject({
    name: "document.pdf",
    encoded: true,
    type: "application/pdf",
  });
});
