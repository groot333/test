from pathlib import Path

path = Path("/opt/astral/api/src/server.js")
text = path.read_text()

backup = Path("/opt/astral/api/src/server.js.bak-before-cors-notfound")
if not backup.exists():
    backup.write_text(text)
    print("OK : sauvegarde CORS créée.")
else:
    print("OK : sauvegarde CORS déjà présente.")

required = [
    "const allowedOrigins =",
    "/health",
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit(
        "ERREUR : structure CORS/health introuvable, aucune modification. Manque : "
        + ", ".join(missing)
    )

BLOCK = 'app.setNotFoundHandler(async (request, reply) => {\n  if (request.method !== "OPTIONS") {\n    return reply.code(404).send({\n      ok: false,\n      error: "Route introuvable.",\n    });\n  }\n\n  const origin = String(request.headers.origin || "").trim();\n  if (origin && !allowedOrigins.includes(origin)) {\n    return reply.code(403).send({\n      ok: false,\n      error: "Origine non autorisée.",\n    });\n  }\n\n  if (origin) {\n    reply.header("access-control-allow-origin", origin);\n    reply.header("vary", "Origin");\n  }\n\n  reply.header(\n    "access-control-allow-methods",\n    "GET, POST, PUT, PATCH, DELETE, OPTIONS",\n  );\n  reply.header(\n    "access-control-allow-headers",\n    "authorization, content-type",\n  );\n  reply.header("access-control-max-age", "86400");\n\n  return reply.code(204).send();\n});\n\n'

if "app.setNotFoundHandler" in text:
    print("OK : fallback OPTIONS déjà présent.")
else:
    health_pos = text.find("/health")
    route_start = text.rfind("app.get", 0, health_pos)
    if health_pos < 0 or route_start < 0:
        raise SystemExit("ERREUR : route /health introuvable pour insertion.")
    text = text[:route_start] + BLOCK + text[route_start:]
    path.write_text(text)
    print("OK : fallback CORS OPTIONS ajouté.")

print("OK : patch CORS terminé.")