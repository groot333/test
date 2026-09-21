from pathlib import Path

path = Path("/opt/astral/api/src/server.js")
text = path.read_text()

backup = Path("/opt/astral/api/src/server.js.bak-before-cors-preflight")
if not backup.exists():
    backup.write_text(text)
    print("OK : sauvegarde CORS créée.")
else:
    print("OK : sauvegarde CORS déjà présente.")

if 'app.options("*"' in text:
    print("OK : route OPTIONS globale déjà présente.")
else:
    anchor = 'allowedHeaders: ["authorization", "content-type"],\n});'
    if anchor not in text:
        raise SystemExit("ERREUR : bloc CORS introuvable. Aucun fichier modifié.")

    block = """app.options("*", async (request, reply) => {
  const origin = String(request.headers.origin || "").trim();
  if (origin && !allowedOrigins.includes(origin)) {
    return reply.code(403).send({
      ok: false,
      error: "Origine non autorisée.",
    });
  }

  if (origin) {
    reply.header("access-control-allow-origin", origin);
    reply.header("vary", "Origin");
  }

  reply.header(
    "access-control-allow-methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  reply.header(
    "access-control-allow-headers",
    "authorization, content-type",
  );
  reply.header("access-control-max-age", "86400");

  return reply.code(204).send();
});"""

    text = text.replace(anchor, anchor + "\n\n" + block, 1)
    path.write_text(text)
    print("OK : route OPTIONS globale ajoutée.")
