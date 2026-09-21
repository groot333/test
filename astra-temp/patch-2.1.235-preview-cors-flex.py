from pathlib import Path
import re

path = Path("/opt/astral/api/src/server.js")
text = path.read_text()

backup = Path("/opt/astral/api/src/server.js.bak-before-preview-cors-flex")
if not backup.exists():
    backup.write_text(text)
    print("OK : sauvegarde preview-cors-flex créée.")
else:
    print("OK : sauvegarde preview-cors-flex déjà présente.")

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
    pos = text.find("await app.register(cors")
    if pos < 0:
        raise SystemExit("ERREUR : plugin CORS introuvable.")
    text = text[:pos] + helper + text[pos:]
    print("OK : règle d'origine Base44 ajoutée.")
else:
    print("OK : règle d'origine Base44 déjà présente.")

cors_start = text.find("await app.register(cors")
cors_end = text.find("});", cors_start)
if cors_start < 0 or cors_end < 0:
    raise SystemExit("ERREUR : bloc CORS introuvable.")

cors_end += 3
cors_block = text[cors_start:cors_end]

if "isAllowedCorsOrigin(origin)" not in cors_block:
    pattern = re.compile(
        r'origin\s*\(\s*origin\s*,\s*callback\s*\)\s*\{.*?callback\s*\(\s*new Error\([^)]*\)\s*,\s*false\s*\)\s*;?\s*\}',
        re.S,
    )
    replacement = '''origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) return callback(null, true);
    callback(new Error("Origine non autorisée"), false);
  }'''
    new_block, count = pattern.subn(replacement, cors_block, count=1)
    if count != 1:
        raise SystemExit("ERREUR : callback CORS non reconnu même en mode flexible.")
    text = text[:cors_start] + new_block + text[cors_end:]
    print("OK : callback CORS remplacé en mode flexible.")
else:
    print("OK : callback CORS déjà compatible Base44.")

# Met à jour le fallback OPTIONS si présent.
if "app.setNotFoundHandler" in text:
    text, count = re.subn(
        r'if\s*\(\s*origin\s*&&\s*!allowedOrigins\.includes\(origin\)\s*\)\s*\{',
        'if (!isAllowedCorsOrigin(origin)) {',
        text,
        count=1,
    )
    if count:
        print("OK : fallback OPTIONS mis à jour.")
    elif "if (!isAllowedCorsOrigin(origin)) {" in text:
        print("OK : fallback OPTIONS déjà compatible Base44.")
    else:
        print("INFO : fallback OPTIONS présent mais aucune ancienne condition à remplacer.")

path.write_text(text)
print("OK : patch CORS Preview Base44 appliqué.")
