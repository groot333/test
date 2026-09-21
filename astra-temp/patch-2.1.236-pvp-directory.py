from pathlib import Path

path = Path("/opt/astral/api/src/server.js")
text = path.read_text()

backup = Path("/opt/astral/api/src/server.js.bak-before-pvp-directory")
if not backup.exists():
    backup.write_text(text)
    print("OK : sauvegarde PVP-directory créée.")
else:
    print("OK : sauvegarde PVP-directory déjà présente.")

# 1) Constante partage bots.
if "const RAID_BOT_SHARE_VPS =" not in text:
    marker = "const MAX_GEMS = 1_000_000;"
    pos = text.find(marker)
    if pos < 0:
        raise SystemExit("ERREUR : MAX_GEMS introuvable.")
    insert_at = pos + len(marker)
    text = text[:insert_at] + "\nconst RAID_BOT_SHARE_VPS = 0.4;" + text[insert_at:]
    print("OK : constante matchmaking ajoutée.")
else:
    print("OK : constante matchmaking déjà présente.")

# 2) Helper recherche.
HELPER = 'const normalizeSearchTextVps = (value) =>\n  String(value || "")\n    .normalize("NFD")\n    .replace(/[\\u0300-\\u036f]/g, "")\n    .toLowerCase()\n    .trim();\n\n'
if "const normalizeSearchTextVps =" not in text:
    marker = "const makeHttpError ="
    pos = text.find(marker)
    if pos < 0:
        raise SystemExit("ERREUR : makeHttpError introuvable.")
    text = text[:pos] + HELPER + text[pos:]
    print("OK : helper recherche ajouté.")
else:
    print("OK : helper recherche déjà présent.")

# 3) Colonnes annuaire PVP.
SCHEMA = '\n\nawait pool.query(`\n  ALTER TABLE astra_players\n  ADD COLUMN IF NOT EXISTS source_id TEXT\n`);\n\nawait pool.query(`\n  ALTER TABLE astra_players\n  ADD COLUMN IF NOT EXISTS xp_level INTEGER NOT NULL DEFAULT 1\n`);\n\nawait pool.query(`\n  ALTER TABLE astra_players\n  ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE\n`);\n\nawait pool.query(`\n  ALTER TABLE astra_players\n  ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ\n`);\n\nawait pool.query(`\n  CREATE INDEX IF NOT EXISTS astra_players_banned_idx\n  ON astra_players (is_banned, updated_at DESC)\n`);\n\n'
if "ADD COLUMN IF NOT EXISTS source_id TEXT" not in text:
    settings_marker = "CREATE TABLE IF NOT EXISTS astra_settings"
    settings_pos = text.find(settings_marker)
    if settings_pos < 0:
        raise SystemExit("ERREUR : table astra_settings introuvable.")
    query_start = text.rfind("await pool.query(", 0, settings_pos)
    if query_start < 0:
        raise SystemExit("ERREUR : point d'insertion schema introuvable.")
    text = text[:query_start] + SCHEMA + text[query_start:]
    print("OK : colonnes annuaire PVP ajoutées.")
else:
    print("OK : colonnes annuaire PVP déjà présentes.")

# 4) Remplace la route status villages par la version avec statistiques annuaire.
STATUS_ROUTE = 'app.get("/v1/admin/villages/status", { preHandler: requireAstraAuth }, async (request, reply) => {\n  if (!isAstraAdminUser(request.astraUser)) {\n    return reply.code(403).send({\n      ok: false,\n      error: "Accès administrateur refusé.",\n    });\n  }\n\n  const [counts, bootstrap, directory] = await Promise.all([\n    pool.query(\n      `SELECT\n         COUNT(*)::int AS total,\n         COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL \'24 hours\')::int AS fresh_24h,\n         COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL \'1 hour\')::int AS fresh_1h\n       FROM astra_villages`,\n    ),\n    pool.query(\n      `SELECT value, updated_at\n         FROM astra_settings\n        WHERE setting_key = \'astra_village_bootstrap\'\n        LIMIT 1`,\n    ),\n    pool.query(\n      `SELECT\n         COUNT(*)::int AS total,\n         COUNT(*) FILTER (WHERE is_banned = TRUE)::int AS banned\n       FROM astra_players`,\n    ),\n  ]);\n\n  return {\n    ok: true,\n    total: Number(counts.rows?.[0]?.total || 0),\n    fresh_24h: Number(counts.rows?.[0]?.fresh_24h || 0),\n    fresh_1h: Number(counts.rows?.[0]?.fresh_1h || 0),\n    directory_total: Number(directory.rows?.[0]?.total || 0),\n    directory_banned: Number(directory.rows?.[0]?.banned || 0),\n    bootstrap: bootstrap.rows?.[0]?.value || null,\n    bootstrap_updated_at: bootstrap.rows?.[0]?.updated_at || null,\n    source: "vps",\n  };\n});\n\n'
status_url = "/v1/admin/villages/status"
status_pos = text.find(status_url)
if status_pos < 0:
    raise SystemExit("ERREUR : route status villages introuvable.")
status_start = text.rfind("app.get", 0, status_pos)
next_import_pos = text.find("/v1/admin/villages/import", status_pos)
status_end = text.rfind("app.post", status_pos, next_import_pos)
if status_start < 0 or next_import_pos < 0 or status_end < 0:
    raise SystemExit("ERREUR : bornes route status villages introuvables.")
text = text[:status_start] + STATUS_ROUTE + text[status_end:]
print("OK : statut miroir enrichi avec annuaire PVP.")

# 5) Nouvelles routes annuaire/matchmaking.
ROUTES = 'app.post(\n  "/v1/admin/players/import",\n  { preHandler: requireAstraAuth, bodyLimit: 1024 * 1024 },\n  async (request, reply) => {\n    if (!isAstraAdminUser(request.astraUser)) {\n      return reply.code(403).send({\n        ok: false,\n        error: "Accès administrateur refusé.",\n      });\n    }\n\n    const players = (\n      Array.isArray(request.body?.players)\n        ? request.body.players\n        : []\n    )\n      .filter(\n        (entry) =>\n          entry &&\n          typeof entry === "object" &&\n          !Array.isArray(entry),\n      )\n      .slice(0, 200);\n\n    let imported = 0;\n    let skipped = 0;\n\n    const client = await pool.connect();\n    try {\n      await client.query("BEGIN");\n\n      for (const entry of players) {\n        const email = normalizeMirrorEmail(entry.email);\n        if (!email) {\n          skipped += 1;\n          continue;\n        }\n\n        const sourceId = String(entry.source_id || "")\n          .trim()\n          .slice(0, 160);\n        const displayName =\n          String(\n            entry.display_name ||\n              email.split("@")[0] ||\n              "Joueur ASTRAL",\n          )\n            .trim()\n            .slice(0, 160) || "Joueur ASTRAL";\n        const xpLevel = clampInt(\n          entry.xp_level || 1,\n          1,\n          100000,\n        );\n        const banned = entry.banned === true;\n        const createdAtText = String(\n          entry.created_at || "",\n        ).trim();\n        const sourceCreatedAt = Number.isFinite(\n          Date.parse(createdAtText),\n        )\n          ? new Date(createdAtText).toISOString()\n          : null;\n\n        await client.query(\n          `INSERT INTO astra_players\n             (user_email, user_id, display_name, source_id, xp_level,\n              is_banned, source_created_at, updated_at)\n           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())\n           ON CONFLICT (user_email)\n           DO UPDATE SET\n             display_name = EXCLUDED.display_name,\n             source_id = EXCLUDED.source_id,\n             xp_level = EXCLUDED.xp_level,\n             is_banned = EXCLUDED.is_banned,\n             source_created_at = COALESCE(\n               EXCLUDED.source_created_at,\n               astra_players.source_created_at\n             ),\n             updated_at = NOW()`,\n          [\n            email,\n            sourceId\n              ? `base44:${sourceId}`\n              : `base44:${email}`,\n            displayName,\n            sourceId || null,\n            xpLevel,\n            banned,\n            sourceCreatedAt,\n          ],\n        );\n\n        imported += 1;\n      }\n\n      await client.query("COMMIT");\n\n      return {\n        ok: true,\n        imported,\n        skipped,\n        received: players.length,\n        source: "vps",\n      };\n    } catch (error) {\n      await client.query("ROLLBACK").catch(() => null);\n      throw error;\n    } finally {\n      client.release();\n    }\n  },\n);\n\napp.post("/v1/admin/players/search", { preHandler: requireAstraAuth }, async (request, reply) => {\n  if (!isAstraAdminUser(request.astraUser)) {\n    return reply.code(403).send({\n      ok: false,\n      error: "Accès administrateur refusé.",\n    });\n  }\n\n  const query = String(request.body?.query || "")\n    .trim()\n    .slice(0, 120);\n  if (query.length < 2) {\n    return reply.code(400).send({\n      ok: false,\n      error: "Saisissez au moins 2 caractères.",\n    });\n  }\n\n  const needle = normalizeSearchTextVps(query);\n  const result = await pool.query(\n    `SELECT\n       p.user_email,\n       p.display_name,\n       p.source_id,\n       p.xp_level,\n       p.is_banned,\n       v.snapshot\n     FROM astra_players p\n     LEFT JOIN astra_villages v\n       ON v.user_email = p.user_email\n     WHERE p.user_email <> $1\n     ORDER BY p.updated_at DESC\n     LIMIT 500`,\n    [request.astraUser.email],\n  );\n\n  const results = (result.rows || [])\n    .filter((row) => row?.is_banned !== true)\n    .map((row) => {\n      const snapshot =\n        row?.snapshot &&\n        typeof row.snapshot === "object" &&\n        !Array.isArray(row.snapshot)\n          ? row.snapshot\n          : {};\n      const email = normalizeMirrorEmail(row?.user_email);\n      if (!email) return null;\n\n      const name =\n        String(\n          snapshot?.user_name ||\n            row?.display_name ||\n            email.split("@")[0] ||\n            "Joueur ASTRAL",\n        )\n          .trim()\n          .slice(0, 160) || "Joueur ASTRAL";\n\n      const haystacks = [\n        email,\n        name,\n        row?.display_name,\n      ]\n        .map(normalizeSearchTextVps)\n        .filter(Boolean);\n\n      const exact = haystacks.some(\n        (value) => value === needle,\n      );\n      const starts = haystacks.some(\n        (value) => value.startsWith(needle),\n      );\n      const contains = haystacks.some(\n        (value) => value.includes(needle),\n      );\n\n      if (!contains) return null;\n\n      return {\n        email,\n        name,\n        level: Math.max(\n          1,\n          Number(\n            snapshot?.player_level ||\n              row?.xp_level ||\n              1,\n          ),\n        ),\n        trophies: Math.max(\n          0,\n          Number(snapshot?.trophies || 0),\n        ),\n        initialized: snapshot?.initialized === true,\n        target_key:\n          String(row?.source_id || "").trim() ||\n          `user:${email}`,\n        rank: exact ? 0 : starts ? 1 : 2,\n      };\n    })\n    .filter(Boolean)\n    .sort(\n      (a, b) =>\n        a.rank - b.rank ||\n        a.name.localeCompare(b.name, "fr"),\n    )\n    .slice(0, 20)\n    .map(({ rank, ...entry }) => entry);\n\n  return {\n    ok: true,\n    results,\n    source: "vps",\n  };\n});\n\napp.post("/v1/raid/player-candidate", { preHandler: requireAstraAuth }, async (request) => {\n  const myEmail = normalizeMirrorEmail(\n    request.astraUser.email,\n  );\n\n  if (request.body?.force_bot === true) {\n    return {\n      ok: true,\n      use_base44: true,\n      force_bot: true,\n      source: "vps",\n    };\n  }\n\n  const excludedTargetList = (\n    Array.isArray(request.body?.exclude_target_keys)\n      ? request.body.exclude_target_keys\n      : []\n  )\n    .slice(-16)\n    .map((value) => String(value || "").trim())\n    .filter(Boolean);\n\n  let consecutivePlayerPreviews = 0;\n  for (\n    let index = excludedTargetList.length - 1;\n    index >= 0;\n    index -= 1\n  ) {\n    if (excludedTargetList[index].startsWith("bot:")) {\n      break;\n    }\n    consecutivePlayerPreviews += 1;\n  }\n\n  if (\n    consecutivePlayerPreviews >= 2 ||\n    secureRandomUnitVps() < RAID_BOT_SHARE_VPS\n  ) {\n    return {\n      ok: true,\n      use_base44: true,\n      force_bot: true,\n      source: "vps",\n    };\n  }\n\n  const myVillage = await pool.query(\n    `SELECT snapshot\n       FROM astra_villages\n      WHERE user_email = $1\n      LIMIT 1`,\n    [myEmail],\n  );\n\n  const mySnapshot =\n    myVillage.rows?.[0]?.snapshot &&\n    typeof myVillage.rows[0].snapshot === "object" &&\n    !Array.isArray(myVillage.rows[0].snapshot)\n      ? myVillage.rows[0].snapshot\n      : {};\n\n  const recentFights = new Set(\n    (\n      Array.isArray(mySnapshot?.recent_targets)\n        ? mySnapshot.recent_targets\n        : []\n    )\n      .slice(-5)\n      .map(normalizeMirrorEmail)\n      .filter(Boolean),\n  );\n  const excludedKeys = new Set(excludedTargetList);\n\n  const candidatesResult = await pool.query(\n    `SELECT\n       p.user_email,\n       p.source_id,\n       p.display_name,\n       p.xp_level,\n       p.is_banned,\n       v.snapshot\n     FROM astra_players p\n     LEFT JOIN astra_villages v\n       ON v.user_email = p.user_email\n     WHERE p.user_email <> $1\n       AND p.is_banned = FALSE\n     ORDER BY p.updated_at DESC\n     LIMIT 500`,\n    [myEmail],\n  );\n\n  const candidates = (candidatesResult.rows || [])\n    .map((row) => {\n      const email = normalizeMirrorEmail(row?.user_email);\n      if (!email || recentFights.has(email)) return null;\n\n      const targetKey =\n        String(row?.source_id || "").trim() ||\n        `user:${email}`;\n\n      return {\n        email,\n        target_key: targetKey,\n        display_name:\n          String(row?.display_name || "")\n            .trim()\n            .slice(0, 160) ||\n          email.split("@")[0] ||\n          "Joueur ASTRAL",\n      };\n    })\n    .filter(Boolean);\n\n  if (!candidates.length) {\n    return {\n      ok: true,\n      use_base44: true,\n      force_bot: true,\n      source: "vps",\n    };\n  }\n\n  const fresh = candidates.filter(\n    (candidate) =>\n      !excludedKeys.has(candidate.target_key),\n  );\n  const poolCandidates = fresh.length\n    ? fresh\n    : candidates;\n  const selected =\n    poolCandidates[\n      secureRandomIntVps(\n        0,\n        Math.max(0, poolCandidates.length - 1),\n      )\n    ];\n\n  return {\n    ok: true,\n    use_base44: false,\n    force_bot: false,\n    candidate: selected,\n    source: "vps",\n  };\n});\n\n'
if "/v1/admin/players/import" not in text:
    daily_pos = text.find("/v1/daily-gift/claim")
    route_start = text.rfind("app.post", 0, daily_pos)
    if daily_pos < 0 or route_start < 0:
        raise SystemExit("ERREUR : route daily-gift introuvable.")
    text = text[:route_start] + ROUTES + text[route_start:]
    print("OK : routes annuaire et matchmaking ajoutées.")
else:
    print("OK : routes annuaire/matchmaking déjà présentes.")

path.write_text(text)
print("OK : patch PVP-directory appliqué.")