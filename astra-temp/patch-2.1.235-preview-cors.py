from pathlib import Path

path = Path("/opt/astral/api/src/server.js")
text = path.read_text()

backup = Path("/opt/astral/api/src/server.js.bak-before-preview-cors")
if not backup.exists():
    backup.write_text(text)
    print("OK : sauvegarde preview-cors créée.")
else:
    print("OK : sauvegarde preview-cors déjà présente.")

if "const allowedOrigins =" not in text:
    raise SystemExit("ERREUR : allowedOrigins introuvable.")

helper = r'''const isAllowedCorsOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host === "base44.app" ||
      host.endsWith(".base44.app") ||
      host === "base44.com" ||
      host.endsWith(".base44.com")
    );
  } catch {
    return false;
  }
};

'''

if "const isAllowedCorsOrigin =" not in text:
    anchor = "await app.register(cors"
    pos = text.find(anchor)
    if pos < 0:
        raise SystemExit("ERREUR : plugin CORS introuvable.")
    text = text[:pos] + helper + text[pos:]
    print("OK : règle d'origine Base44 ajoutée.")
else:
    print("OK : règle d'origine Base44 déjà présente.")

old = '''  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Origine non autorisée"), false);
  },'''
new = '''  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) return callback(null, true);
    callback(new Error("Origine non autorisée"), false);
  },'''

if old in text:
    text = text.replace(old, new, 1)
    print("OK : callback CORS mis à jour.")
elif "if (isAllowedCorsOrigin(origin)) return callback(null, true);" in text:
    print("OK : callback CORS déjà mis à jour.")
else:
    raise SystemExit("ERREUR : callback CORS non reconnu.")

old_nf = 'if (origin && !allowedOrigins.includes(origin)) {'
new_nf = 'if (!isAllowedCorsOrigin(origin)) {'

if old_nf in text:
    text = text.replace(old_nf, new_nf, 1)
    print("OK : fallback OPTIONS mis à jour.")
elif new_nf in text:
    print("OK : fallback OPTIONS déjà mis à jour.")
else:
    raise SystemExit("ERREUR : fallback OPTIONS non reconnu.")

path.write_text(text)
print("OK : patch Preview Base44 CORS appliqué.")
