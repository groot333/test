import crypto from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import pg from "pg";
import Redis from "ioredis";
import { requireAstraAuth } from "./auth.js";
import { registerVpsLoadTest } from "./loadTest.js";

const { Pool } = pg;
const app = Fastify({ logger: true, trustProxy: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
});

const MAX_RESOURCE = 1_000_000_000;
const MAX_GEMS = 1_000_000;
const RAID_BOT_SHARE_VPS = 0.4;
const MAX_RAID_BUILDINGS_VPS = 400;
const RAID_REPLAY_HZ_VPS = 30;
const MAX_RAID_REPLAY_STEPS_VPS = RAID_REPLAY_HZ_VPS * 10 * 60;
const MAX_RAID_REPLAY_INPUTS_VPS = 240;
const MAX_RAID_REPLAY_ACTORS_VPS = 5;
const SORCERER_CREDIT_REDEEM_CENTS_VPS = 5000;
const SORCERER_CREDIT_REDEEM_EUROS_VPS =
  SORCERER_CREDIT_REDEEM_CENTS_VPS / 100;

const clampInt = (value, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.floor(number)));
};

const parisDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const normalizeDailyProgress = (raw, today = parisDateKey()) => {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (String(source.date || "") !== today) {
    return { date: today, wins: 0, destroyed: 0, gold: 0, upgrades: 0, claimed: [] };
  }
  const claimed = Array.isArray(source.claimed)
    ? [...new Set(source.claimed.map((value) => String(value || "").slice(0, 120)).filter(Boolean))].slice(0, 1000)
    : [];
  return {
    date: today,
    wins: clampInt(source.wins, 0, MAX_RESOURCE),
    destroyed: clampInt(source.destroyed, 0, MAX_RESOURCE),
    gold: clampInt(source.gold, 0, MAX_RESOURCE),
    upgrades: clampInt(source.upgrades, 0, MAX_RESOURCE),
    claimed,
  };
};

const VPS_ACHIEVEMENTS = {
  win1: { stat: "wins", goal: 1, reward: { gems: 25 } },
  win10: { stat: "wins", goal: 10, reward: { legendChest: 1 } },
  destroy100: { stat: "destroyed", goal: 100, reward: { gems: 100 } },
  upgrade10: { stat: "upgrades", goal: 10, reward: { fragment: 30 } },
};

const VPS_LEGACY_QUESTS = {
  firstBuild: { stat: "built", goal: 1, reward: { gold: 400, gems: 10 } },
  firstUpgrade: { stat: "upgrades", goal: 2, reward: { mana: 900, rareChest: 1 } },
  gold10000: { stat: "gold", goal: 10000, reward: { gems: 50, epicChest: 1 } },
  destroy20: { stat: "destroyed", goal: 20, reward: { crystals: 80, fragment: 10 } },
  dailyWins: { stat: "wins", goal: 3, daily: true, reward: { gems: 30, rareChest: 1 } },
  dailyGold: { stat: "gold", goal: 1000, daily: true, reward: { mana: 600, potion: 2 } },
  dailyUpgrade: { stat: "upgrades", goal: 1, daily: true, reward: { gold: 500, chest: 1 } },
};

const ENERGY_CAPACITY = 100;
const ENERGY_REGEN_MS = 60 * 1000;
const MAX_CAMPAIGN_STAGES = 200;
const SECURE_CHEST_IDS = new Set([
  "chest",
  "starterRareChest",
  "rareChest",
  "epicChest",
  "legendChest",
]);

const BASE_BUILDING_STORAGE = {
  vault: { storage: "gold", capacity: 8000 },
  reservoir: { storage: "mana", capacity: 8000 },
  warehouse: { storage: "both", capacity: 4500 },
};

const DEFAULT_SECURE_SHOP = {
  gold: { cost: { gems: 20 }, reward: { gold: 3000 } },
  mana: { cost: { gems: 20 }, reward: { mana: 3000 } },
  energy: { cost: { gems: 10 }, reward: { energy: 30 } },
  common: { cost: { gold: 500 }, reward: { chest: 1 } },
  rare: { cost: { gems: 30 }, reward: { rareChest: 1 } },
  epic: { cost: { gems: 60 }, reward: { epicChest: 1 } },
  legend: { cost: { gems: 100 }, reward: { legendChest: 1 } },
  elixir: { cost: { mana: 900 }, reward: { potion: 3 } },
  blade: { cost: { gold: 1800 }, reward: { blade: 1 } },
  crystals: { cost: { mana: 1500 }, reward: { crystals: 50 } },
};

const BASE_GUARDIAN_RARITY = {
  minotaur: "Légendaire",
  harpy: "Épique",
  mummy: "Rare",
  gargoyle: "Épique",
  dragon: "Divin",
  toad: "Rare",
  imp: "Commun",
  cerberus: "Mythique",
  golem: "Mythique",
  spectre: "Légendaire",
  knight: "Épique",
  abyss: "Mythique",
  anubis: "Légendaire",
};

const BASE_GUARDIAN_DROP_WEIGHT = {
  minotaur: 25,
  harpy: 45,
  mummy: 70,
  gargoyle: 45,
  dragon: 5,
  toad: 70,
  imp: 100,
  cerberus: 12,
  golem: 12,
  spectre: 25,
  knight: 45,
  abyss: 14,
  anubis: 22,
};

const BASE_ITEM_RARITY = {
  blade: "Rare",
  plate: "Épique",
  amulet: "Rare",
  orb: "Légendaire",
  potion: "Commun",
  fragment: "Épique",
};

const DEFAULT_SECURE_CHESTS = {
  chest: {
    monsterChance: 35,
    rarities: {
      Commun: 60,
      Rare: 30,
      "Épique": 9,
      "Légendaire": 1,
      Mythique: 0,
      Divin: 0,
    },
    equipment: { potion: 55, blade: 25, amulet: 20 },
    goldMin: 180,
    goldMax: 400,
    mana: 180,
  },
  starterRareChest: {
    monsterChance: 100,
    rarities: {
      Commun: 100,
      Rare: 0,
      "Épique": 0,
      "Légendaire": 0,
      Mythique: 0,
      Divin: 0,
    },
    equipment: { potion: 1 },
    goldMin: 400,
    goldMax: 800,
    mana: 360,
  },
  rareChest: {
    monsterChance: 60,
    rarities: {
      Commun: 15,
      Rare: 50,
      "Épique": 28,
      "Légendaire": 6,
      Mythique: 1,
      Divin: 0,
    },
    equipment: {
      potion: 20,
      blade: 35,
      amulet: 30,
      plate: 15,
    },
    goldMin: 400,
    goldMax: 800,
    mana: 360,
  },
  epicChest: {
    monsterChance: 80,
    rarities: {
      Commun: 0,
      Rare: 15,
      "Épique": 58,
      "Légendaire": 22,
      Mythique: 4,
      Divin: 1,
    },
    equipment: {
      blade: 15,
      amulet: 20,
      plate: 45,
      orb: 20,
    },
    goldMin: 700,
    goldMax: 1300,
    mana: 600,
  },
  legendChest: {
    monsterChance: 100,
    rarities: {
      Commun: 0,
      Rare: 0,
      "Épique": 25,
      "Légendaire": 55,
      Mythique: 17,
      Divin: 3,
    },
    equipment: { plate: 40, orb: 60 },
    goldMin: 1200,
    goldMax: 2200,
    mana: 1000,
  },
};

const DEFAULT_GUARDIAN_EVOLUTION_VPS = {
  enabled: true,
  maxLevel0: 50,
  maxLevel1: 100,
  maxLevel2: 150,
  maxLevel3: 200,
  requiredCopies1: 2,
  requiredCopies2: 4,
  requiredCopies3: 8,
  essenceCost1: 50,
  essenceCost2: 200,
  essenceCost3: 500,
  manaCost1: 25000,
  manaCost2: 100000,
  manaCost3: 300000,
};

const validSlug = (value) =>
  /^[a-zA-Z0-9_-]{1,80}$/.test(String(value || ""));

const secureRandomUnitVps = () =>
  crypto.randomBytes(4).readUInt32BE(0) / 0x100000000;

const secureRandomIntVps = (min, max) => {
  const low = Math.floor(
    Math.min(Number(min || 0), Number(max || 0)),
  );
  const high = Math.floor(
    Math.max(Number(min || 0), Number(max || 0)),
  );
  if (high <= low) return low;
  return low + Math.floor(
    secureRandomUnitVps() * (high - low + 1),
  );
};

const secureWeightedVps = (entries) => {
  const valid = (Array.isArray(entries) ? entries : [])
    .map(([id, weight]) => [String(id), Number(weight)])
    .filter(
      ([, weight]) =>
        Number.isFinite(weight) && weight > 0,
    );
  const total = valid.reduce(
    (sum, [, weight]) => sum + weight,
    0,
  );
  if (!total) return null;

  let cursor = secureRandomUnitVps() * total;
  for (const [id, weight] of valid) {
    cursor -= weight;
    if (cursor < 0) return id;
  }
  return valid[valid.length - 1]?.[0] || null;
};

const secureChestConfigVps = (adminConfig, chestId) => {
  const fallback = DEFAULT_SECURE_CHESTS[chestId];
  if (!fallback) return null;

  const override = adminConfig?.chests?.[chestId];
  if (
    !override ||
    typeof override !== "object" ||
    Array.isArray(override)
  ) {
    return fallback;
  }

  return {
    ...fallback,
    ...override,
    rarities: {
      ...(fallback.rarities || {}),
      ...(override.rarities || {}),
    },
    equipment: {
      ...(fallback.equipment || {}),
      ...(override.equipment || {}),
    },
  };
};

const secureGuardianCatalogVps = (adminConfig) => {
  const merged = {};

  for (const [id, rarity] of Object.entries(
    BASE_GUARDIAN_RARITY,
  )) {
    merged[id] = {
      id,
      rarity,
      dropWeight: Number(
        BASE_GUARDIAN_DROP_WEIGHT[id] || 1,
      ),
      disabled: false,
    };
  }

  for (const [id, source] of Object.entries(
    adminConfig?.monsters || {},
  )) {
    if (
      !validSlug(id) ||
      !source ||
      typeof source !== "object" ||
      Array.isArray(source)
    ) {
      continue;
    }

    const previous = merged[id] || {
      id,
      rarity: "Commun",
      dropWeight: 100,
      disabled: false,
    };

    merged[id] = {
      ...previous,
      ...source,
      id,
      rarity: String(
        source.rarity ||
          previous.rarity ||
          "Commun",
      ),
      dropWeight: Math.max(
        0,
        Number(
          source.dropWeight ??
            previous.dropWeight ??
            1,
        ),
      ),
      disabled: source.disabled === true,
    };
  }

  return merged;
};

const guardianXpNeededVps = (level) =>
  Math.round(
    100 *
      Math.pow(
        Math.max(1, Number(level || 1)),
        1.45,
      ),
  );

const guardianMaxLevelForStarsVps = (
  stars,
  adminConfig,
) => {
  const safeStars = Math.max(
    0,
    Math.min(3, Math.floor(Number(stars || 0))),
  );
  const raw =
    adminConfig?.guardianEvolution?.[
      `maxLevel${safeStars}`
    ];
  const fallback =
    DEFAULT_GUARDIAN_EVOLUTION_VPS[
      `maxLevel${safeStars}`
    ];
  return clampInt(raw ?? fallback, 1, 200);
};

const applyGuardianXpVps = (
  hero,
  amount,
  adminConfig,
) => {
  const gain = Math.max(0, Number(amount || 0));
  if (!gain || !hero) return hero;

  const maxLevel = guardianMaxLevelForStarsVps(
    hero.evolutionStars,
    adminConfig,
  );

  if (Number(hero.level || 1) >= maxLevel) {
    return hero;
  }

  hero.xp = Math.min(
    MAX_RESOURCE,
    Math.max(0, Number(hero.xp || 0)) + gain,
  );
  hero.progress_revision = Math.min(
    MAX_RESOURCE,
    Math.max(
      0,
      Math.floor(Number(hero.progress_revision || 0)),
    ) + 1,
  );

  while (
    Number(hero.level || 1) < maxLevel &&
    hero.xp >= guardianXpNeededVps(hero.level)
  ) {
    hero.xp -= guardianXpNeededVps(hero.level);
    hero.level = Number(hero.level || 1) + 1;
  }

  if (Number(hero.level || 1) >= maxLevel) {
    hero.xp = 0;
  }

  return hero;
};

async function loadVpsAdminConfig() {
  const result = await pool.query(
    `SELECT value, revision
       FROM astra_settings
      WHERE setting_key = 'astra_admin_config'
      LIMIT 1`,
  );
  if (!result.rowCount) {
    throw makeHttpError(
      503,
      "Configuration ASTRAL absente du VPS. Réessayez après synchronisation.",
    );
  }
  return {
    config:
      result.rows[0].value &&
      typeof result.rows[0].value === "object" &&
      !Array.isArray(result.rows[0].value)
        ? result.rows[0].value
        : {},
    revision: Number(result.rows[0].revision || 0),
  };
}

const secureShopOfferVps = (adminConfig, offerId) => {
  let base = DEFAULT_SECURE_SHOP[offerId]
    ? {
        id: offerId,
        ...DEFAULT_SECURE_SHOP[offerId],
        defaultEnabled: true,
      }
    : null;

  if (!base && String(offerId || "").startsWith("item_")) {
    const itemId = String(offerId).slice(5);
    if (validSlug(itemId) && adminConfig?.items?.[itemId]) {
      base = {
        id: offerId,
        cost: { gems: 50 },
        reward: { [itemId]: 1 },
        defaultEnabled: false,
      };
    }
  }

  if (!base) return null;

  const override =
    adminConfig?.shop?.[offerId] &&
    typeof adminConfig.shop[offerId] === "object" &&
    !Array.isArray(adminConfig.shop[offerId])
      ? adminConfig.shop[offerId]
      : {};

  const enabled =
    typeof override.enabled === "boolean"
      ? override.enabled
      : base.defaultEnabled !== false;

  if (!enabled) return null;

  const originalCurrency =
    Object.keys(base.cost || {})[0] || "gems";
  const currency = String(
    override.currency || originalCurrency,
  );
  if (!validSlug(currency)) return null;

  const originalPrice = Math.max(
    1,
    Math.floor(
      Number(Object.values(base.cost || {})[0] || 1),
    ),
  );

  const price = Number.isFinite(Number(override.price))
    ? Math.max(1, Math.floor(Number(override.price)))
    : originalPrice;

  return {
    ...base,
    cost: { [currency]: price },
  };
};

const secureMarketDiscountVps = (buildingsRaw) => {
  const buildings = Array.isArray(buildingsRaw)
    ? buildingsRaw
    : [];
  const marketLevels = buildings
    .filter(
      (building) =>
        building &&
        building.type === "market" &&
        building.stored !== true &&
        !building.buildEnd,
    )
    .reduce(
      (sum, building) =>
        sum + Math.max(1, Number(building.level || 1)),
      0,
    );
  return Math.min(0.15, marketLevels * 0.03);
};

const secureStorageCapacityVps = (
  adminConfig,
  buildingsRaw,
  type,
) => {
  let capacity = 10000;
  const buildings = Array.isArray(buildingsRaw)
    ? buildingsRaw
    : [];

  for (const building of buildings) {
    if (!building || building.stored === true || building.buildEnd) {
      continue;
    }

    const base =
      BASE_BUILDING_STORAGE[building.type] || {};
    const override =
      adminConfig?.buildings?.[building.type] &&
      typeof adminConfig.buildings[building.type] === "object" &&
      !Array.isArray(adminConfig.buildings[building.type])
        ? adminConfig.buildings[building.type]
        : {};

    const storage = String(
      override.storage ?? base.storage ?? "",
    );
    if (storage !== type && storage !== "both") continue;

    const unitCapacity = Math.max(
      0,
      Number(
        override.capacity ?? base.capacity ?? 0,
      ),
    );

    capacity +=
      unitCapacity *
      Math.max(1, Number(building.level || 1));
  }

  return Math.max(
    10000,
    Math.min(MAX_RESOURCE, Math.floor(capacity)),
  );
};

const materializeEnergyResources = (
  resourcesRaw,
  now = Date.now(),
) => {
  const resources =
    resourcesRaw &&
    typeof resourcesRaw === "object" &&
    !Array.isArray(resourcesRaw)
      ? { ...resourcesRaw }
      : {};

  const initialized =
    resources.energy_initialized === true;
  let energy = clampInt(
    resources.energy,
    0,
    ENERGY_CAPACITY,
  );
  let revision = clampInt(
    resources.energy_revision,
    0,
    MAX_RESOURCE,
  );
  let updatedAt = Number(
    resources.energy_updated_at || 0,
  );

  if (!initialized) {
    return {
      resources,
      initialized: false,
      energy,
      revision,
      updatedAt: 0,
    };
  }

  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    updatedAt = now;
  }
  updatedAt = Math.min(now, updatedAt);

  if (energy < ENERGY_CAPACITY) {
    const gained = Math.floor(
      Math.max(0, now - updatedAt) /
        ENERGY_REGEN_MS,
    );

    if (gained > 0) {
      const actual = Math.min(
        gained,
        ENERGY_CAPACITY - energy,
      );
      energy += actual;
      revision = Math.min(
        MAX_RESOURCE,
        revision + actual,
      );
      updatedAt =
        energy >= ENERGY_CAPACITY
          ? now
          : updatedAt +
            gained * ENERGY_REGEN_MS;
    }
  }

  resources.energy_initialized = true;
  resources.energy = energy;
  resources.energy_revision = revision;
  resources.energy_updated_at = updatedAt;

  return {
    resources,
    initialized: true,
    energy,
    revision,
    updatedAt,
  };
};

const normalizeCampaignRewardVps = (raw) => {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }

  for (const [key, rawValue] of Object.entries(raw)) {
    const safeKey = String(key || "").slice(0, 64);
    const amount = clampInt(
      rawValue,
      0,
      100_000_000,
    );
    if (!safeKey || !amount) continue;
    out[safeKey] = amount;
    if (Object.keys(out).length >= 40) break;
  }

  return out;
};

const normalizeCampaignProgressVps = (raw) => {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw
      : {};
  const stars = {};
  const cooldowns = {};
  const settlements = {};

  const sourceStars =
    source.stars &&
    typeof source.stars === "object" &&
    !Array.isArray(source.stars)
      ? source.stars
      : {};

  const sourceCooldowns =
    source.cooldowns &&
    typeof source.cooldowns === "object" &&
    !Array.isArray(source.cooldowns)
      ? source.cooldowns
      : {};

  for (const [rawKey, rawValue] of Object.entries(
    sourceStars,
  )) {
    const key = String(rawKey || "").slice(0, 4);
    const stage = Number(key);
    if (
      !/^\d{1,3}$/.test(key) ||
      !Number.isInteger(stage) ||
      stage < 0 ||
      stage >= MAX_CAMPAIGN_STAGES
    ) {
      continue;
    }
    const star = clampInt(rawValue, 0, 3);
    if (star > 0) stars[key] = star;
  }

  for (const [rawKey, rawValue] of Object.entries(
    sourceCooldowns,
  )) {
    const key = String(rawKey || "").slice(0, 4);
    const stage = Number(key);
    const until = Math.max(0, Number(rawValue || 0));
    if (
      !/^\d{1,3}$/.test(key) ||
      !Number.isInteger(stage) ||
      stage < 0 ||
      stage >= MAX_CAMPAIGN_STAGES ||
      !Number.isFinite(until)
    ) {
      continue;
    }
    if (until > 0) cooldowns[key] = Math.floor(until);
  }

  const rawSettlements =
    source.settlements &&
    typeof source.settlements === "object" &&
    !Array.isArray(source.settlements)
      ? source.settlements
      : {};

  for (const [id, entry] of Object.entries(
    rawSettlements,
  )) {
    const key = String(id || "").slice(0, 120);
    const cooldownUntil = Math.max(
      0,
      Number(entry?.cooldown_until || 0),
    );
    if (!key || !Number.isFinite(cooldownUntil)) continue;

    settlements[key] = {
      stage: clampInt(
        entry?.stage,
        0,
        MAX_CAMPAIGN_STAGES - 1,
      ),
      stars: clampInt(entry?.stars, 0, 3),
      first_clear: entry?.first_clear === true,
      cooldown_until: Math.floor(cooldownUntil),
      settled_at: Math.max(
        0,
        Math.floor(Number(entry?.settled_at || 0)),
      ),
      reward: normalizeCampaignRewardVps(
        entry?.reward,
      ),
      first_clear_reward:
        normalizeCampaignRewardVps(
          entry?.first_clear_reward,
        ),
    };

    if (Object.keys(settlements).length >= 300) {
      break;
    }
  }

  const cleared = Object.entries(stars)
    .filter(([, value]) => Number(value || 0) > 0)
    .map(([key]) => Number(key))
    .filter(Number.isFinite);

  const highestCleared = cleared.length
    ? Math.max(...cleared)
    : -1;

  return {
    unlocked: Math.max(
      clampInt(
        source.unlocked,
        0,
        MAX_CAMPAIGN_STAGES - 1,
      ),
      highestCleared >= 0
        ? Math.min(
            MAX_CAMPAIGN_STAGES - 1,
            highestCleared + 1,
          )
        : 0,
    ),
    stars,
    cooldowns,
    settlements,
  };
};

const normalizeDungeonProgressVps = (raw) => {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw
      : {};
  const cooldowns = {};
  const settlements = {};

  const sourceCooldowns =
    source.cooldowns &&
    typeof source.cooldowns === "object" &&
    !Array.isArray(source.cooldowns)
      ? source.cooldowns
      : {};

  for (const [id, value] of Object.entries(
    sourceCooldowns,
  )) {
    const key = String(id || "").slice(0, 80);
    const until = Math.max(0, Number(value || 0));
    if (
      !/^dungeon_[a-z0-9_]+$/i.test(key) ||
      !Number.isFinite(until) ||
      until <= 0
    ) {
      continue;
    }
    cooldowns[key] = Math.floor(until);
    if (Object.keys(cooldowns).length >= 100) break;
  }

  const rawSettlements =
    source.settlements &&
    typeof source.settlements === "object" &&
    !Array.isArray(source.settlements)
      ? source.settlements
      : {};

  for (const [id, entry] of Object.entries(
    rawSettlements,
  )) {
    const key = String(id || "").slice(0, 120);
    const dungeonId = String(
      entry?.dungeon_id || "",
    ).slice(0, 80);
    const cooldownUntil = Math.max(
      0,
      Number(entry?.cooldown_until || 0),
    );

    if (
      !key ||
      !/^dungeon_[a-z0-9_]+$/i.test(dungeonId) ||
      !Number.isFinite(cooldownUntil)
    ) {
      continue;
    }

    settlements[key] = {
      dungeon_id: dungeonId,
      stars: clampInt(entry?.stars, 0, 3),
      cooldown_until: Math.floor(cooldownUntil),
    };

    if (Object.keys(settlements).length >= 200) {
      break;
    }
  }

  return { cooldowns, settlements };
};

const loadCampaignStagesVps = (adminConfig) => {
  const campaigns = Array.isArray(adminConfig?.campaigns)
    ? adminConfig.campaigns.slice(0, 20)
    : [];

  const stages = [];

  for (
    let campaignIndex = 0;
    campaignIndex < campaigns.length;
    campaignIndex += 1
  ) {
    const campaign = campaigns[campaignIndex];
    const rawCampaignId = String(
      campaign?.id || "",
    )
      .trim()
      .toLowerCase();
    const campaignId =
      /^campaign_[a-z0-9_]{1,50}$/.test(rawCampaignId)
        ? rawCampaignId
        : `campaign_${campaignIndex + 1}`;
    const sourceStages = Array.isArray(campaign?.stages)
      ? campaign.stages.slice(0, 50)
      : [];

    for (
      let stageIndex = 0;
      stageIndex < sourceStages.length;
      stageIndex += 1
    ) {
      if (stages.length >= MAX_CAMPAIGN_STAGES) {
        break;
      }

      const source = sourceStages[stageIndex];

      stages.push({
        campaign_id: campaignId,
        campaign_index: campaignIndex,
        stage_index: stageIndex,
        energyCost: clampInt(
          source?.energyCost ?? 5,
          0,
          10_000,
        ),
        cooldownHours: Math.max(
          0,
          Math.min(
            8760,
            Number(source?.cooldownHours ?? 7),
          ),
        ),
        duration: clampInt(
          source?.duration ?? 180,
          30,
          600,
        ),
        reward: normalizeCampaignRewardVps(
          source?.reward,
        ),
        firstClearReward:
          normalizeCampaignRewardVps(
            source?.firstClearReward,
          ),
      });
    }
  }

  if (!stages.length) {
    throw makeHttpError(
      503,
      "Campagnes absentes de la configuration VPS.",
    );
  }

  return stages;
};

const applySnapshotGemDelta = (snapshot, delta) => {
  const resources = ensureSnapshotResources(snapshot);
  const before = Number(resources.gems || 0);
  resources.gems = Math.max(
    0,
    Math.min(
      MAX_GEMS,
      before + Math.floor(Number(delta || 0)),
    ),
  );
  resources.gems_revision = Math.min(
    MAX_RESOURCE,
    Number(resources.gems_revision || 0) + 1,
  );
  snapshot.resources = resources;
  return resources.gems;
};

const normalizeGlobalGiftVps = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = String(raw.id || "").trim().slice(0, 120);
  const gems = clampInt(raw.gems, 1, MAX_GEMS);
  const publishedAt = String(raw.published_at || "").trim();
  if (!id || !Number.isFinite(Date.parse(publishedAt))) return null;
  return {
    id,
    gems,
    published_at: publishedAt,
    title: String(raw.title || "Cadeau !").trim().slice(0, 80) || "Cadeau !",
    subtitle:
      String(raw.subtitle || `${gems.toLocaleString("fr-FR")} gemmes offertes !`)
        .trim()
        .slice(0, 120) || `${gems.toLocaleString("fr-FR")} gemmes offertes !`,
    message: String(
      raw.message ||
        "Cadeau de l’équipe Astral : merci de faire partie de l’aventure.",
    )
      .trim()
      .slice(0, 500),
    button_label:
      String(raw.button_label || "Réclamer").trim().slice(0, 40) || "Réclamer",
  };
};

const normalizeMerchantImageVps = (value) => {
  const image = String(value || "").trim();
  if (!image || image.length > 6000) return "";
  if (/^https?:\/\//i.test(image)) return image;
  if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(image)) return image;
  return "";
};

const normalizeMerchantOfferVps = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const id = String(raw.id || "").trim().slice(0, 120);
  const guardianType = String(raw.guardian_type || "").trim().slice(0, 64);
  if (!id || !validSlug(guardianType)) return null;

  const levelMode = raw.level_mode === "range" ? "range" : "exact";
  const exactLevel = clampInt(raw.level_exact ?? raw.level_min ?? 1, 1, 200);
  let levelMin = clampInt(raw.level_min ?? exactLevel, 1, 200);
  let levelMax = clampInt(raw.level_max ?? exactLevel, 1, 200);
  if (levelMin > levelMax) [levelMin, levelMax] = [levelMax, levelMin];

  const activationMode = ["manual", "scheduled", "random"].includes(
    String(raw.activation_mode || ""),
  )
    ? String(raw.activation_mode)
    : "manual";

  const publishedAt = String(raw.published_at || "").trim();
  const startsAt = String(raw.starts_at || publishedAt || "").trim();
  const endsAt = String(raw.ends_at || "").trim();

  return {
    id,
    enabled: raw.enabled === true,
    guardian_type: guardianType,
    guardian_name:
      String(raw.guardian_name || guardianType).trim().slice(0, 120) || guardianType,
    level_mode: levelMode,
    level_exact: exactLevel,
    level_min: levelMin,
    level_max: levelMax,
    reward_gems: clampInt(raw.reward_gems, 1, MAX_GEMS),
    activation_mode: activationMode,
    starts_at: Number.isFinite(Date.parse(startsAt))
      ? new Date(startsAt).toISOString()
      : "",
    ends_at:
      endsAt && Number.isFinite(Date.parse(endsAt))
        ? new Date(endsAt).toISOString()
        : "",
    published_at: Number.isFinite(Date.parse(publishedAt))
      ? new Date(publishedAt).toISOString()
      : new Date().toISOString(),
  };
};

async function queueGlobalBackup(client, action) {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO astra_global_backup_queue
       (id, action, status, created_at)
     VALUES ($1, $2::jsonb, 'pending', NOW())`,
    [id, JSON.stringify(action || {})],
  );
  return id;
}

const isAstraAdminUser = (user) =>
  String(user?.email || "").trim().toLowerCase() === ASTRA_ADMIN_EMAIL ||
  String(user?.role || "").trim().toLowerCase() === "admin";

const cloneSnapshot = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value))
    : {};

const snapshotSyncMs = (snapshot) => {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return 0;
  for (const value of [
    snapshot.synced_at,
    snapshot.last_active_at,
    snapshot.updated_at,
    snapshot.created_at,
  ]) {
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
};

const mirrorSnapshot = (raw) => {
  const snapshot = cloneSnapshot(raw);
  for (const key of Object.keys(snapshot)) {
    if (key.startsWith("_vps_")) delete snapshot[key];
  }
  return snapshot;
};

const normalizeMirrorEmail = (value) => {
  const email = String(value || "").trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
};

const normalizeSearchTextVps = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const creditSnapshotVps = (row = {}) => {
  const cents = Math.max(
    0,
    Math.round(Number(row?.balance_cents || 0)),
  );
  return {
    cents,
    euros: cents / 100,
    lifetimeCents: Math.max(
      0,
      Math.round(Number(row?.lifetime_cents || 0)),
    ),
    redeemThresholdCents:
      SORCERER_CREDIT_REDEEM_CENTS_VPS,
    redeemThresholdEuros:
      SORCERER_CREDIT_REDEEM_EUROS_VPS,
    canRedeem:
      cents >= SORCERER_CREDIT_REDEEM_CENTS_VPS,
  };
};

const sorcererExchangeCodeVps = (
  email,
  redeemKey,
) => {
  const suffix = crypto
    .createHash("sha256")
    .update(
      String(email || "").toLowerCase() +
        "|" +
        String(redeemKey || ""),
      "utf8",
    )
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return "SORCIER50-" + suffix;
};

async function ensureCreditWalletTx(
  client,
  email,
  name = "",
) {
  const normalized = normalizeMirrorEmail(email);
  if (!normalized) {
    throw makeHttpError(
      400,
      "Compte Crédit Sorcier invalide.",
    );
  }

  await client.query(
    `INSERT INTO astra_credit_wallets
       (user_email, user_name, balance_cents,
        lifetime_cents, updated_at)
     VALUES ($1, $2, 0, 0, NOW())
     ON CONFLICT (user_email)
     DO UPDATE SET
       user_name = CASE
         WHEN EXCLUDED.user_name <> ''
           THEN EXCLUDED.user_name
         ELSE astra_credit_wallets.user_name
       END`,
    [
      normalized,
      String(name || "").trim().slice(0, 160),
    ],
  );

  const result = await client.query(
    `SELECT *
       FROM astra_credit_wallets
      WHERE user_email = $1
      LIMIT 1
      FOR UPDATE`,
    [normalized],
  );
  return result.rows[0];
}

async function applyCreditDeltaTx(
  client,
  {
    email,
    name = "",
    deltaCents = 0,
    eventKey = "",
    reason = "",
    refId = "",
  },
) {
  const normalized = normalizeMirrorEmail(email);
  const key = String(eventKey || "")
    .trim()
    .slice(0, 240);
  if (!normalized || !key) {
    throw makeHttpError(
      400,
      "Évènement Crédit Sorcier invalide.",
    );
  }

  const existing = await client.query(
    `SELECT delta_cents, balance_after_cents
       FROM astra_credit_events
      WHERE event_key = $1
      LIMIT 1`,
    [key],
  );
  if (existing.rowCount) {
    const wallet = await ensureCreditWalletTx(
      client,
      normalized,
      name,
    );
    return {
      duplicate: true,
      appliedCents: 0,
      wallet,
      event: existing.rows[0],
    };
  }

  const wallet = await ensureCreditWalletTx(
    client,
    normalized,
    name,
  );
  const before = Math.max(
    0,
    Math.round(Number(wallet.balance_cents || 0)),
  );
  const requested = Math.round(
    Number(deltaCents || 0),
  );
  const after = Math.max(0, before + requested);
  const applied = after - before;
  const lifetimeAfter =
    Math.max(
      0,
      Math.round(Number(wallet.lifetime_cents || 0)),
    ) + Math.max(0, applied);

  const saved = await client.query(
    `UPDATE astra_credit_wallets
        SET balance_cents = $2,
            lifetime_cents = $3,
            user_name = CASE
              WHEN $4 <> '' THEN $4
              ELSE user_name
            END,
            updated_at = NOW()
      WHERE user_email = $1
      RETURNING *`,
    [
      normalized,
      after,
      lifetimeAfter,
      String(name || "").trim().slice(0, 160),
    ],
  );

  await client.query(
    `INSERT INTO astra_credit_events
       (event_key, user_email, delta_cents,
        balance_after_cents, reason, ref_id,
        created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      key,
      normalized,
      applied,
      after,
      String(reason || "").slice(0, 120),
      String(refId || "").slice(0, 180),
    ],
  );

  return {
    duplicate: false,
    appliedCents: applied,
    wallet: saved.rows[0],
  };
}

const stableRollVps = (seed, min, max, salt = "") => {
  const text = `${String(seed || "")}|${salt}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return min + ((hash >>> 0) % (max - min + 1));
};

const clampNumberVps = (value, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
};

const normalizeRaidReplayVps = (raw, raidSnapshot) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const seed = Math.max(
    1,
    Math.floor(Number(raidSnapshot?.replay_seed || 0)),
  );
  if (!seed) return null;

  const team = [
    ...new Set(
      (Array.isArray(raw.team) ? raw.team : [])
        .slice(0, MAX_RAID_REPLAY_ACTORS_VPS)
        .map((value) =>
          String(value || "").trim().slice(0, 100),
        )
        .filter(Boolean),
    ),
  ];
  if (!team.length) return null;

  const teamIds = new Set(team);
  const actors = (
    Array.isArray(raw.actors) ? raw.actors : []
  )
    .slice(0, MAX_RAID_REPLAY_ACTORS_VPS)
    .map((actor) => ({
      id: String(actor?.id || "").trim().slice(0, 100),
      type: String(actor?.type || "").trim().slice(0, 64),
      level: clampInt(actor?.level || 1, 1, 200),
      evolution_stars: clampInt(
        actor?.evolution_stars || 0,
        0,
        3,
      ),
      max_hp: clampNumberVps(
        actor?.max_hp || 1,
        1,
        MAX_RESOURCE,
      ),
      attack: clampNumberVps(
        actor?.attack || 0,
        0,
        MAX_RESOURCE,
      ),
      defense: clampNumberVps(
        actor?.defense || 0,
        0,
        MAX_RESOURCE,
      ),
      magic_defense: clampNumberVps(
        actor?.magic_defense || 0,
        0,
        MAX_RESOURCE,
      ),
      skill_power: clampNumberVps(
        actor?.skill_power || 1,
        0.01,
        100,
      ),
    }))
    .filter(
      (actor) =>
        teamIds.has(actor.id) &&
        validSlug(actor.type),
    );

  const actorIds = new Set(
    actors.map((actor) => actor.id),
  );
  const durationSteps = clampInt(
    raw.duration_steps || 1,
    1,
    MAX_RAID_REPLAY_STEPS_VPS,
  );
  const inputs = (
    Array.isArray(raw.inputs) ? raw.inputs : []
  )
    .slice(0, MAX_RAID_REPLAY_INPUTS_VPS)
    .map((entry) => {
      const kind = String(entry?.kind || "");
      const step = clampInt(
        entry?.step || 0,
        0,
        durationSteps,
      );
      if (kind === "auto") {
        return {
          kind,
          step,
          value: entry?.value === true,
        };
      }

      const actorId = String(
        entry?.actor_id || "",
      )
        .trim()
        .slice(0, 100);
      if (!actorIds.has(actorId)) return null;

      if (kind === "skill") {
        return { kind, step, actor_id: actorId };
      }

      if (kind === "deploy") {
        return {
          kind,
          step,
          actor_id: actorId,
          x:
            Math.round(
              clampNumberVps(entry?.x, 0, 50) *
                1000,
            ) / 1000,
          y:
            Math.round(
              clampNumberVps(entry?.y, 0, 50) *
                1000,
            ) / 1000,
        };
      }

      return null;
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        Number(a?.step || 0) -
        Number(b?.step || 0),
    );

  const reason = [
    "complete",
    "timeout",
    "fallen",
    "retreat",
  ].includes(String(raw.reason || ""))
    ? String(raw.reason)
    : "timeout";

  return {
    version: 1,
    engine: "astra-v21-replay-1",
    hz: RAID_REPLAY_HZ_VPS,
    seed,
    auto_skills_initial:
      raw.auto_skills_initial !== false,
    team,
    actors,
    inputs,
    duration_steps: durationSteps,
    reason,
    result: {
      stars: clampInt(
        raw?.result?.stars || 0,
        0,
        3,
      ),
      destruction_pct: clampNumberVps(
        raw?.result?.destruction_pct || 0,
        0,
        100,
      ),
    },
  };
};

const settleRaidBuildingDamageVps = (
  current,
  reserved,
  claimedIds,
  version,
  now,
) => {
  const requested = new Set(
    (Array.isArray(claimedIds) ? claimedIds : [])
      .slice(0, MAX_RAID_BUILDINGS_VPS)
      .map(String),
  );
  const authorized = new Map(
    (Array.isArray(reserved) ? reserved : [])
      .filter(
        (building) =>
          building?.stored !== true &&
          building?.ruined !== true &&
          Number(building?.hp || 0) > 0 &&
          requested.has(String(building?.id)),
      )
      .map((building) => [
        String(building.id),
        building,
      ]),
  );

  return (Array.isArray(current) ? current : []).map(
    (building) => {
      const old = authorized.get(
        String(building?.id),
      );
      if (
        !old ||
        building?.ruined === true ||
        building?.stored === true ||
        old?.type !== building?.type ||
        Number(old?.ruinVersion || 0) !==
          Number(building?.ruinVersion || 0)
      ) {
        return building;
      }

      return {
        ...building,
        hp: 0,
        ruined: true,
        ruinVersion: version,
        destroyedAt: now,
        restoredHp: Math.max(
          1,
          Number(building?.hp || 0),
          Number(building?.restoredHp || 0),
          Number(old?.hp || 0),
        ),
      };
    },
  );
};

const defaultRaidBuildingsVps = () => [
  {
    id: crypto.randomUUID(),
    type: "castle",
    x: 23,
    y: 22,
    level: 1,
    rotation: 0,
    stored: false,
    hp: 4500,
    ruined: false,
  },
  {
    id: crypto.randomUUID(),
    type: "gold",
    x: 17,
    y: 22,
    level: 1,
    rotation: 0,
    stored: false,
    hp: 1300,
    ruined: false,
  },
  {
    id: crypto.randomUUID(),
    type: "mana",
    x: 29,
    y: 23,
    level: 1,
    rotation: 0,
    stored: false,
    hp: 1300,
    ruined: false,
  },
];

const normalizeRaidBuildingsVps = (snapshot) => {
  const initialized = snapshot?.initialized === true;
  const raw = Array.isArray(snapshot?.buildings)
    ? snapshot.buildings
    : [];
  if (
    !initialized ||
    !raw.some(
      (building) =>
        String(building?.type || "") === "castle" &&
        building?.stored !== true,
    )
  ) {
    return defaultRaidBuildingsVps();
  }

  return raw
    .filter(
      (building) =>
        building &&
        typeof building === "object" &&
        !Array.isArray(building),
    )
    .slice(0, 600)
    .map((building) => ({
      ...building,
      id:
        String(building?.id || "").trim().slice(0, 120) ||
        crypto.randomUUID(),
      type: String(building?.type || "").trim().slice(0, 80),
      x: Math.round(Number(building?.x || 0)),
      y: Math.round(Number(building?.y || 0)),
      level: Math.max(1, Math.round(Number(building?.level || 1))),
      stored: building?.stored === true,
      ruined:
        building?.ruined === true ||
        Number(building?.hp || 0) <= 0,
      hp:
        building?.ruined === true ||
        Number(building?.hp || 0) <= 0
          ? 0
          : Math.max(1, Number(building?.hp || 1)),
    }))
    .filter((building) => validSlug(building.type));
};

const defenderPositionsVps = (buildings, rawDefenders) => {
  const castle =
    (Array.isArray(buildings) ? buildings : []).find(
      (building) =>
        building?.type === "castle" &&
        building?.stored !== true,
    ) || { x: 23, y: 22 };
  const spots = [
    [0, -5],
    [5, 0],
    [-5, 0],
    [4, 5],
    [-4, 5],
  ];

  return (
    Array.isArray(rawDefenders)
      ? rawDefenders
      : []
  )
    .filter(
      (defender) =>
        defender &&
        typeof defender === "object" &&
        !Array.isArray(defender) &&
        validSlug(defender?.type || defender?.id),
    )
    .slice(0, 5)
    .map((defender, index) => {
      const type = String(
        defender?.type || defender?.id || "",
      );
      return {
        id:
          String(defender?.id || type)
            .trim()
            .slice(0, 120) || type,
        type,
        level: clampInt(defender?.level || 1, 1, 200),
        evolutionStars: clampInt(
          defender?.evolutionStars || 0,
          0,
          3,
        ),
        x: clampInt(
          Number(castle?.x || 23) + spots[index][0],
          10,
          40,
        ),
        y: clampInt(
          Number(castle?.y || 22) + spots[index][1],
          10,
          40,
        ),
      };
    });
};

const makeHttpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode });

const ensureSnapshotResources = (snapshot) => {
  const resources =
    snapshot.resources && typeof snapshot.resources === "object" && !Array.isArray(snapshot.resources)
      ? { ...snapshot.resources }
      : {};
  resources.gems = clampInt(resources.gems, 0, MAX_GEMS);
  resources.gems_revision = clampInt(resources.gems_revision, 0, MAX_RESOURCE);
  resources.gems_initialized = true;
  return resources;
};

const addSnapshotGems = (snapshot, amount) => {
  const resources = ensureSnapshotResources(snapshot);
  resources.gems = Math.min(MAX_GEMS, resources.gems + Math.max(0, Math.floor(Number(amount || 0))));
  resources.gems_revision = Math.min(MAX_RESOURCE, resources.gems_revision + 1);
  snapshot.resources = resources;
};

const snapshotInventory = (snapshot) =>
  snapshot.inventory && typeof snapshot.inventory === "object" && !Array.isArray(snapshot.inventory)
    ? { ...snapshot.inventory }
    : {};

const markVpsBackupPending = (
  snapshot,
  now = new Date().toISOString(),
  action = null,
) => {
  snapshot._vps_pilot_pending_backup = true;
  snapshot._vps_pilot_saved_at = now;
  if (action && typeof action === "object" && !Array.isArray(action)) {
    snapshot._vps_pilot_pending_action = JSON.parse(JSON.stringify(action));
  }
  return snapshot;
};

async function mutateLockedVillage(request, reply, mutator) {
  const user = request.astraUser;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT revision, snapshot
         FROM astra_villages
        WHERE user_email = $1
        FOR UPDATE`,
      [user.email],
    );
    if (!current.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ ok: false, error: "Village introuvable." });
    }

    const row = current.rows[0];
    const revision = Number(row.revision || 0);
    const snapshot = cloneSnapshot(row.snapshot);
    const outcome = await mutator(snapshot, revision, client);

    if (outcome?.write === false) {
      await client.query("COMMIT");
      return {
        ...(outcome.response || {}),
        village: outcome.village || snapshot,
        revision,
        source: "vps",
      };
    }

    const nextSnapshot = outcome?.snapshot || snapshot;
    const nextRevision = revision + 1;
    await client.query(
      `UPDATE astra_villages
          SET revision = $2,
              snapshot = $3::jsonb,
              updated_at = NOW()
        WHERE user_email = $1`,
      [user.email, nextRevision, JSON.stringify(nextSnapshot)],
    );
    await client.query("COMMIT");

    return {
      ...(outcome?.response || {}),
      village: nextSnapshot,
      revision: nextRevision,
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

const ASTRA_ADMIN_EMAIL = "kevincattoenpro@gmail.com";

await pool.query(`
  ALTER TABLE astra_players
  ADD COLUMN IF NOT EXISTS source_id TEXT
`);

await pool.query(`
  ALTER TABLE astra_players
  ADD COLUMN IF NOT EXISTS xp_level INTEGER NOT NULL DEFAULT 1
`);

await pool.query(`
  ALTER TABLE astra_players
  ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE
`);

await pool.query(`
  ALTER TABLE astra_players
  ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ
`);

await pool.query(`
  CREATE INDEX IF NOT EXISTS astra_players_banned_idx
  ON astra_players (is_banned, updated_at DESC)
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS astra_raids (
    id TEXT PRIMARY KEY,
    reservation_token TEXT NOT NULL UNIQUE,
    attacker_email TEXT NOT NULL,
    attacker_name TEXT NOT NULL DEFAULT '',
    defender_email TEXT NOT NULL,
    defender_name TEXT NOT NULL DEFAULT '',
    defender_village_id TEXT,
    target_key TEXT NOT NULL DEFAULT '',
    snapshot JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved',
    gold_available BIGINT NOT NULL DEFAULT 0,
    mana_available BIGINT NOT NULL DEFAULT 0,
    gold_stolen BIGINT NOT NULL DEFAULT 0,
    mana_stolen BIGINT NOT NULL DEFAULT 0,
    stars INTEGER NOT NULL DEFAULT 0,
    destruction_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    replay JSONB,
    defender_seen BOOLEAN NOT NULL DEFAULT FALSE,
    is_revenge BOOLEAN NOT NULL DEFAULT FALSE,
    revenge_of TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

await pool.query(`
  CREATE INDEX IF NOT EXISTS astra_raids_attacker_idx
  ON astra_raids (attacker_email, created_at DESC)
`);

await pool.query(`
  CREATE INDEX IF NOT EXISTS astra_raids_defender_idx
  ON astra_raids (defender_email, resolved_at DESC)
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS settlement_started_at TIMESTAMPTZ
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS credit_gain_cents INTEGER NOT NULL DEFAULT 0
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS credit_loss_pct INTEGER NOT NULL DEFAULT 0
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS credit_lost_cents INTEGER NOT NULL DEFAULT 0
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS credit_winner_email TEXT
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS credit_loser_email TEXT
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS credit_settled BOOLEAN NOT NULL DEFAULT FALSE
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS credit_winner_balance_after_cents INTEGER NOT NULL DEFAULT 0
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS credit_loser_balance_after_cents INTEGER NOT NULL DEFAULT 0
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS revenged_at TIMESTAMPTZ
`);

await pool.query(`
  ALTER TABLE astra_raids
  ADD COLUMN IF NOT EXISTS revenge_raid_id TEXT
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS astra_credit_wallets (
    user_email TEXT PRIMARY KEY,
    user_name TEXT NOT NULL DEFAULT '',
    balance_cents BIGINT NOT NULL DEFAULT 0,
    lifetime_cents BIGINT NOT NULL DEFAULT 0,
    imported_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS astra_credit_events (
    event_key TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    delta_cents BIGINT NOT NULL,
    balance_after_cents BIGINT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    ref_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

await pool.query(`
  CREATE INDEX IF NOT EXISTS astra_credit_events_user_idx
  ON astra_credit_events (user_email, created_at DESC)
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS astra_credit_redemptions (
    user_email TEXT NOT NULL,
    redeem_key TEXT NOT NULL,
    source_id TEXT NOT NULL,
    code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_email, redeem_key),
    UNIQUE (code)
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS astra_settings (
    setting_key TEXT PRIMARY KEY,
    revision BIGINT NOT NULL DEFAULT 0,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS astra_quest_history (
    id BIGSERIAL PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    user_email TEXT NOT NULL,
    user_name TEXT NOT NULL DEFAULT '',
    quest_id TEXT NOT NULL,
    quest_name TEXT NOT NULL,
    quest_type TEXT NOT NULL DEFAULT '',
    objective TEXT NOT NULL DEFAULT '',
    record_type TEXT NOT NULL DEFAULT 'quest',
    outcome TEXT NOT NULL DEFAULT 'won',
    period_key TEXT NOT NULL DEFAULT '',
    run_index INTEGER NOT NULL DEFAULT 1,
    attempt_index INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 0,
    boss_type TEXT NOT NULL DEFAULT '',
    boss_name TEXT NOT NULL DEFAULT '',
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

await pool.query(`
  CREATE INDEX IF NOT EXISTS astra_quest_history_occurred_at_idx
  ON astra_quest_history (occurred_at DESC)
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS astra_global_gifts (
    id TEXT PRIMARY KEY,
    gift JSONB NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS astra_global_gift_claims (
    gift_id TEXT NOT NULL REFERENCES astra_global_gifts(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL,
    award JSONB NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (gift_id, user_email)
  )
`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS astra_global_backup_queue (
    id TEXT PRIMARY KEY,
    action JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
  )
`);

await pool.query(`
  CREATE INDEX IF NOT EXISTS astra_global_backup_queue_status_idx
  ON astra_global_backup_queue (status, created_at)
`);

const allowedOrigins = String(process.env.ASTRA_ALLOWED_ORIGIN || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const isAllowedCorsOrigin = (origin) => {
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

await app.register(cors, {
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) return callback(null, true);
    callback(new Error("Origine non autorisée"), false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["authorization", "content-type"],
});

app.setNotFoundHandler(async (request, reply) => {
  if (request.method !== "OPTIONS") {
    return reply.code(404).send({
      ok: false,
      error: "Route introuvable.",
    });
  }

  const origin = String(request.headers.origin || "").trim();
  if (!isAllowedCorsOrigin(origin)) {
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
});

app.get("/health", async () => {
  const [db, cache] = await Promise.all([
    pool.query("SELECT 1 AS ok"),
    redis.ping(),
  ]);
  return {
    ok: db.rows?.[0]?.ok === 1 && cache === "PONG",
    service: "astral-vps-api",
    timestamp: new Date().toISOString(),
  };
});

app.get("/v1/me", { preHandler: requireAstraAuth }, async (request) => ({
  ok: true,
  user: request.astraUser,
}));

app.get("/v1/village", { preHandler: requireAstraAuth }, async (request) => {
  const email = request.astraUser.email;
  const result = await pool.query(
    `SELECT user_email, revision, snapshot, updated_at
       FROM astra_villages
      WHERE user_email = $1
      LIMIT 1`,
    [email],
  );

  if (!result.rowCount) {
    return { ok: true, village: null, source: "vps" };
  }

  const row = result.rows[0];
  return {
    ok: true,
    village: row.snapshot,
    revision: Number(row.revision || 0),
    updated_at: row.updated_at,
    source: "vps",
  };
});

app.put("/v1/village", { preHandler: requireAstraAuth }, async (request, reply) => {
  const user = request.astraUser;
  const snapshot = request.body?.snapshot;
  const expectedRevision = Number(request.body?.expected_revision ?? 0);

  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return reply.code(400).send({ ok: false, error: "Snapshot de village invalide." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT revision
         FROM astra_villages
        WHERE user_email = $1
        FOR UPDATE`,
      [user.email],
    );

    const revision = current.rowCount ? Number(current.rows[0].revision || 0) : 0;
    if (current.rowCount && expectedRevision !== revision) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error: "Conflit de sauvegarde.",
        current_revision: revision,
      });
    }

    const nextRevision = revision + 1;
    await client.query(
      `INSERT INTO astra_players (user_email, user_id, display_name, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_email)
       DO UPDATE SET user_id = EXCLUDED.user_id,
                     display_name = EXCLUDED.display_name,
                     updated_at = NOW()`,
      [user.email, user.userId, user.name],
    );

    await client.query(
      `INSERT INTO astra_villages (user_email, revision, snapshot, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (user_email)
       DO UPDATE SET revision = EXCLUDED.revision,
                     snapshot = EXCLUDED.snapshot,
                     updated_at = NOW()`,
      [user.email, nextRevision, JSON.stringify(snapshot)],
    );

    await client.query("COMMIT");
    return {
      ok: true,
      revision: nextRevision,
      updated_at: new Date().toISOString(),
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/village/mirror", { preHandler: requireAstraAuth }, async (request, reply) => {
  const user = request.astraUser;
  const snapshot = mirrorSnapshot(request.body?.snapshot);

  if (!snapshot || !Object.keys(snapshot).length) {
    return reply.code(400).send({
      ok: false,
      error: "Snapshot de village invalide.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [user.email],
    );

    const current = await client.query(
      `SELECT revision, snapshot
         FROM astra_villages
        WHERE user_email = $1
        FOR UPDATE`,
      [user.email],
    );

    const revision = current.rowCount
      ? Number(current.rows[0].revision || 0)
      : 0;
    const currentSnapshot = current.rowCount
      ? cloneSnapshot(current.rows[0].snapshot)
      : null;

    const incomingMs = snapshotSyncMs(snapshot);
    const currentMs = snapshotSyncMs(currentSnapshot);

    if (
      current.rowCount &&
      incomingMs > 0 &&
      currentMs > 0 &&
      incomingMs + 1500 < currentMs
    ) {
      await client.query("COMMIT");
      return {
        ok: true,
        mirrored: false,
        skipped_stale: true,
        revision,
        source: "vps",
      };
    }

    await client.query(
      `INSERT INTO astra_players (user_email, user_id, display_name, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_email)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         display_name = EXCLUDED.display_name,
         updated_at = NOW()`,
      [user.email, user.userId, user.name],
    );

    const nextRevision = revision + 1;

    await client.query(
      `INSERT INTO astra_villages (user_email, revision, snapshot, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (user_email)
       DO UPDATE SET
         revision = EXCLUDED.revision,
         snapshot = EXCLUDED.snapshot,
         updated_at = NOW()`,
      [user.email, nextRevision, JSON.stringify(snapshot)],
    );

    await client.query("COMMIT");

    return {
      ok: true,
      mirrored: true,
      skipped_stale: false,
      revision: nextRevision,
      updated_at: new Date().toISOString(),
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/admin/villages/status", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const [counts, bootstrap, directory] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '24 hours')::int AS fresh_24h,
         COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '1 hour')::int AS fresh_1h
       FROM astra_villages`,
    ),
    pool.query(
      `SELECT value, updated_at
         FROM astra_settings
        WHERE setting_key = 'astra_village_bootstrap'
        LIMIT 1`,
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_banned = TRUE)::int AS banned
       FROM astra_players`,
    ),
  ]);

  return {
    ok: true,
    total: Number(counts.rows?.[0]?.total || 0),
    fresh_24h: Number(counts.rows?.[0]?.fresh_24h || 0),
    fresh_1h: Number(counts.rows?.[0]?.fresh_1h || 0),
    directory_total: Number(directory.rows?.[0]?.total || 0),
    directory_banned: Number(directory.rows?.[0]?.banned || 0),
    bootstrap: bootstrap.rows?.[0]?.value || null,
    bootstrap_updated_at: bootstrap.rows?.[0]?.updated_at || null,
    source: "vps",
  };
});

app.post(
  "/v1/admin/villages/import",
  { preHandler: requireAstraAuth, bodyLimit: 4 * 1024 * 1024 },
  async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const entries = (Array.isArray(request.body?.entries) ? request.body.entries : [])
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .slice(0, 4);
  const finalBatch = request.body?.final === true;
  const expectedTotal = clampInt(request.body?.expected_total || 0, 0, 5000);

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let stale = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const entry of entries) {
      const email = normalizeMirrorEmail(entry.email);
      const snapshot = mirrorSnapshot(entry.snapshot);

      if (!email || !Object.keys(snapshot).length) {
        skipped += 1;
        continue;
      }

      if (email === ASTRA_ADMIN_EMAIL) {
        skipped += 1;
        continue;
      }

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [email],
      );

      const current = await client.query(
        `SELECT revision, snapshot
           FROM astra_villages
          WHERE user_email = $1
          FOR UPDATE`,
        [email],
      );

      const revision = current.rowCount
        ? Number(current.rows[0].revision || 0)
        : 0;
      const currentSnapshot = current.rowCount
        ? cloneSnapshot(current.rows[0].snapshot)
        : null;
      const incomingMs = snapshotSyncMs(snapshot);
      const currentMs = snapshotSyncMs(currentSnapshot);

      if (
        current.rowCount &&
        incomingMs > 0 &&
        currentMs > 0 &&
        incomingMs + 1500 < currentMs
      ) {
        stale += 1;
        continue;
      }

      const displayName =
        String(entry.display_name || snapshot.user_name || email.split("@")[0] || "Joueur ASTRAL")
          .trim()
          .slice(0, 160) || "Joueur ASTRAL";

      await client.query(
        `INSERT INTO astra_players (user_email, user_id, display_name, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_email)
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           updated_at = NOW()`,
        [email, `base44:${email}`, displayName],
      );

      const nextRevision = revision + 1;
      await client.query(
        `INSERT INTO astra_villages (user_email, revision, snapshot, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (user_email)
         DO UPDATE SET
           revision = EXCLUDED.revision,
           snapshot = EXCLUDED.snapshot,
           updated_at = NOW()`,
        [email, nextRevision, JSON.stringify(snapshot)],
      );

      if (current.rowCount) updated += 1;
      else imported += 1;

      const sourceId = String(entry.source_id || snapshot.id || "").trim().slice(0, 180);
      if (sourceId) {
        await client.query(
          `INSERT INTO astra_migration_log
             (user_email, source, entity_name, source_id, imported_at, details)
           VALUES ($1, 'base44', 'AstraVillage', $2, NOW(), $3::jsonb)
           ON CONFLICT DO NOTHING`,
          [
            email,
            sourceId,
            JSON.stringify({
              mirrored_at: new Date().toISOString(),
              synced_at: snapshot.synced_at || null,
            }),
          ],
        );
      }
    }

    if (finalBatch) {
      const completedAt = new Date().toISOString();
      const value = {
        completed_at: completedAt,
        expected_total: expectedTotal,
      };

      await client.query(
        `INSERT INTO astra_settings (setting_key, revision, value, updated_at)
         VALUES ('astra_village_bootstrap', 1, $1::jsonb, NOW())
         ON CONFLICT (setting_key)
         DO UPDATE SET
           revision = astra_settings.revision + 1,
           value = EXCLUDED.value,
           updated_at = NOW()`,
        [JSON.stringify(value)],
      );
    }

    await client.query("COMMIT");

    return {
      ok: true,
      imported,
      updated,
      skipped,
      stale,
      received: entries.length,
      final: finalBatch,
      expected_total: expectedTotal,
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
  },
);

app.post(
  "/v1/admin/players/import",
  { preHandler: requireAstraAuth, bodyLimit: 1024 * 1024 },
  async (request, reply) => {
    if (!isAstraAdminUser(request.astraUser)) {
      return reply.code(403).send({
        ok: false,
        error: "Accès administrateur refusé.",
      });
    }

    const players = (
      Array.isArray(request.body?.players)
        ? request.body.players
        : []
    )
      .filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry),
      )
      .slice(0, 200);

    let imported = 0;
    let skipped = 0;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const entry of players) {
        const email = normalizeMirrorEmail(entry.email);
        if (!email) {
          skipped += 1;
          continue;
        }

        const sourceId = String(entry.source_id || "")
          .trim()
          .slice(0, 160);
        const displayName =
          String(
            entry.display_name ||
              email.split("@")[0] ||
              "Joueur ASTRAL",
          )
            .trim()
            .slice(0, 160) || "Joueur ASTRAL";
        const xpLevel = clampInt(
          entry.xp_level || 1,
          1,
          100000,
        );
        const banned = entry.banned === true;
        const createdAtText = String(
          entry.created_at || "",
        ).trim();
        const sourceCreatedAt = Number.isFinite(
          Date.parse(createdAtText),
        )
          ? new Date(createdAtText).toISOString()
          : null;

        await client.query(
          `INSERT INTO astra_players
             (user_email, user_id, display_name, source_id, xp_level,
              is_banned, source_created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (user_email)
           DO UPDATE SET
             display_name = EXCLUDED.display_name,
             source_id = EXCLUDED.source_id,
             xp_level = EXCLUDED.xp_level,
             is_banned = EXCLUDED.is_banned,
             source_created_at = COALESCE(
               EXCLUDED.source_created_at,
               astra_players.source_created_at
             ),
             updated_at = NOW()`,
          [
            email,
            sourceId
              ? `base44:${sourceId}`
              : `base44:${email}`,
            displayName,
            sourceId || null,
            xpLevel,
            banned,
            sourceCreatedAt,
          ],
        );

        imported += 1;
      }

      await client.query("COMMIT");

      return {
        ok: true,
        imported,
        skipped,
        received: players.length,
        source: "vps",
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => null);
      throw error;
    } finally {
      client.release();
    }
  },
);

app.post("/v1/admin/players/search", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const query = String(request.body?.query || "")
    .trim()
    .slice(0, 120);
  if (query.length < 2) {
    return reply.code(400).send({
      ok: false,
      error: "Saisissez au moins 2 caractères.",
    });
  }

  const needle = normalizeSearchTextVps(query);
  const result = await pool.query(
    `SELECT
       p.user_email,
       p.display_name,
       p.source_id,
       p.xp_level,
       p.is_banned,
       v.snapshot
     FROM astra_players p
     LEFT JOIN astra_villages v
       ON v.user_email = p.user_email
     WHERE p.user_email <> $1
     ORDER BY p.updated_at DESC
     LIMIT 500`,
    [request.astraUser.email],
  );

  const results = (result.rows || [])
    .filter((row) => row?.is_banned !== true)
    .map((row) => {
      const snapshot =
        row?.snapshot &&
        typeof row.snapshot === "object" &&
        !Array.isArray(row.snapshot)
          ? row.snapshot
          : {};
      const email = normalizeMirrorEmail(row?.user_email);
      if (!email) return null;

      const name =
        String(
          snapshot?.user_name ||
            row?.display_name ||
            email.split("@")[0] ||
            "Joueur ASTRAL",
        )
          .trim()
          .slice(0, 160) || "Joueur ASTRAL";

      const haystacks = [
        email,
        name,
        row?.display_name,
      ]
        .map(normalizeSearchTextVps)
        .filter(Boolean);

      const exact = haystacks.some(
        (value) => value === needle,
      );
      const starts = haystacks.some(
        (value) => value.startsWith(needle),
      );
      const contains = haystacks.some(
        (value) => value.includes(needle),
      );

      if (!contains) return null;

      return {
        email,
        name,
        level: Math.max(
          1,
          Number(
            snapshot?.player_level ||
              row?.xp_level ||
              1,
          ),
        ),
        trophies: Math.max(
          0,
          Number(snapshot?.trophies || 0),
        ),
        initialized: snapshot?.initialized === true,
        target_key:
          String(row?.source_id || "").trim() ||
          `user:${email}`,
        rank: exact ? 0 : starts ? 1 : 2,
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.name.localeCompare(b.name, "fr"),
    )
    .slice(0, 20)
    .map(({ rank, ...entry }) => entry);

  return {
    ok: true,
    results,
    source: "vps",
  };
});

app.post("/v1/raid/player-candidate", { preHandler: requireAstraAuth }, async (request) => {
  const myEmail = normalizeMirrorEmail(
    request.astraUser.email,
  );

  if (request.body?.force_bot === true) {
    return {
      ok: true,
      use_base44: true,
      force_bot: true,
      source: "vps",
    };
  }

  const excludedTargetList = (
    Array.isArray(request.body?.exclude_target_keys)
      ? request.body.exclude_target_keys
      : []
  )
    .slice(-16)
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  let consecutivePlayerPreviews = 0;
  for (
    let index = excludedTargetList.length - 1;
    index >= 0;
    index -= 1
  ) {
    if (excludedTargetList[index].startsWith("bot:")) {
      break;
    }
    consecutivePlayerPreviews += 1;
  }

  if (
    consecutivePlayerPreviews >= 2 ||
    secureRandomUnitVps() < RAID_BOT_SHARE_VPS
  ) {
    return {
      ok: true,
      use_base44: true,
      force_bot: true,
      source: "vps",
    };
  }

  const myVillage = await pool.query(
    `SELECT snapshot
       FROM astra_villages
      WHERE user_email = $1
      LIMIT 1`,
    [myEmail],
  );

  const mySnapshot =
    myVillage.rows?.[0]?.snapshot &&
    typeof myVillage.rows[0].snapshot === "object" &&
    !Array.isArray(myVillage.rows[0].snapshot)
      ? myVillage.rows[0].snapshot
      : {};

  const recentFights = new Set(
    (
      Array.isArray(mySnapshot?.recent_targets)
        ? mySnapshot.recent_targets
        : []
    )
      .slice(-5)
      .map(normalizeMirrorEmail)
      .filter(Boolean),
  );
  const excludedKeys = new Set(excludedTargetList);

  const candidatesResult = await pool.query(
    `SELECT
       p.user_email,
       p.source_id,
       p.display_name,
       p.xp_level,
       p.is_banned,
       v.snapshot
     FROM astra_players p
     LEFT JOIN astra_villages v
       ON v.user_email = p.user_email
     WHERE p.user_email <> $1
       AND p.is_banned = FALSE
     ORDER BY p.updated_at DESC
     LIMIT 500`,
    [myEmail],
  );

  const candidates = (candidatesResult.rows || [])
    .map((row) => {
      const email = normalizeMirrorEmail(row?.user_email);
      if (!email || recentFights.has(email)) return null;

      const targetKey =
        String(row?.source_id || "").trim() ||
        `user:${email}`;

      return {
        email,
        target_key: targetKey,
        display_name:
          String(row?.display_name || "")
            .trim()
            .slice(0, 160) ||
          email.split("@")[0] ||
          "Joueur ASTRAL",
      };
    })
    .filter(Boolean);

  if (!candidates.length) {
    return {
      ok: true,
      use_base44: true,
      force_bot: true,
      source: "vps",
    };
  }

  const fresh = candidates.filter(
    (candidate) =>
      !excludedKeys.has(candidate.target_key),
  );
  const poolCandidates = fresh.length
    ? fresh
    : candidates;
  const selected =
    poolCandidates[
      secureRandomIntVps(
        0,
        Math.max(0, poolCandidates.length - 1),
      )
    ];

  return {
    ok: true,
    use_base44: false,
    force_bot: false,
    candidate: selected,
    source: "vps",
  };
});

app.post("/v1/raid/reserve-player", { preHandler: requireAstraAuth }, async (request, reply) => {
  const attackerEmail = normalizeMirrorEmail(request.astraUser.email);
  const targetEmail = normalizeMirrorEmail(request.body?.target_email);

  if (!targetEmail || targetEmail === attackerEmail) {
    return reply.code(400).send({
      ok: false,
      error: "Ce joueur ne peut pas être ciblé.",
    });
  }

  const result = await pool.query(
    `SELECT
       p.user_email,
       p.display_name,
       p.source_id,
       p.xp_level,
       p.is_banned,
       v.snapshot
     FROM astra_players p
     LEFT JOIN astra_villages v
       ON v.user_email = p.user_email
     WHERE p.user_email = $1
     LIMIT 1`,
    [targetEmail],
  );

  if (!result.rowCount) {
    return reply.code(404).send({
      ok: false,
      error: "Joueur introuvable dans ASTRAL.",
    });
  }

  const row = result.rows[0];
  if (row?.is_banned === true) {
    return reply.code(403).send({
      ok: false,
      error: "Ce joueur ne peut pas être ciblé.",
    });
  }

  const snapshot =
    row?.snapshot &&
    typeof row.snapshot === "object" &&
    !Array.isArray(row.snapshot)
      ? cloneSnapshot(row.snapshot)
      : {};

  const initialized = snapshot?.initialized === true;
  const buildings = normalizeRaidBuildingsVps(snapshot);

  if (
    !buildings.some(
      (building) =>
        building?.stored !== true &&
        building?.ruined !== true &&
        Number(building?.hp || 0) > 0 &&
        building?.type !== "wall",
    )
  ) {
    return reply.code(409).send({
      ok: false,
      error: "Ce village ne peut pas être attaqué pour le moment.",
    });
  }

  if (
    initialized &&
    buildings.some(
      (building) =>
        building?.stored !== true &&
        (
          building?.ruined === true ||
          Number(building?.hp || 0) <= 0
        ),
    )
  ) {
    return reply.code(409).send({
      ok: false,
      error:
        "Ce village contient encore des bâtiments détruits et est protégé pour le moment.",
    });
  }

  const defenders = initialized
    ? defenderPositionsVps(
        buildings,
        snapshot?.defenders,
      )
    : [];

  const resources =
    snapshot?.resources &&
    typeof snapshot.resources === "object" &&
    !Array.isArray(snapshot.resources)
      ? snapshot.resources
      : {};

  const goldAvailable = Math.floor(
    Math.max(0, Number(resources?.gold || 0)) * 0.25,
  );
  const manaAvailable = Math.floor(
    Math.max(0, Number(resources?.mana || 0)) * 0.25,
  );

  const reservationToken = crypto.randomUUID();
  const raidId = crypto.randomUUID();
  const replaySeed = secureRandomIntVps(
    1,
    2_147_483_646,
  );
  const startedAt = new Date().toISOString();
  const targetKey =
    String(request.body?.target_key || "")
      .trim()
      .slice(0, 180) ||
    String(row?.source_id || "").trim().slice(0, 180) ||
    `user:${targetEmail}`;
  const defenderName =
    String(
      snapshot?.user_name ||
        row?.display_name ||
        targetEmail.split("@")[0] ||
        "Joueur ASTRAL",
    )
      .trim()
      .slice(0, 160) || "Joueur ASTRAL";
  const defenderVillageId =
    String(snapshot?.id || targetEmail)
      .trim()
      .slice(0, 180) || targetEmail;

  const raidSnapshot = {
    target_type: "player",
    replay_seed: replaySeed,
    buildings,
    defenders,
    removed_obstacles: Array.isArray(
      snapshot?.removed_obstacles,
    )
      ? snapshot.removed_obstacles.slice(0, 600)
      : [],
    initialized,
    player_level: Math.max(
      1,
      Number(
        snapshot?.player_level ||
          row?.xp_level ||
          1,
      ),
    ),
    trophies: Math.max(
      0,
      Number(snapshot?.trophies || 0),
    ),
    vps_reserved: true,
    admin_targeted:
      request.body?.admin_targeted === true,
  };

  await pool.query(
    `INSERT INTO astra_raids
       (id, reservation_token, attacker_email, attacker_name,
        defender_email, defender_name, defender_village_id,
        target_key, snapshot, status, gold_available,
        mana_available, started_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
        'reserved', $10, $11, $12, NOW())`,
    [
      raidId,
      reservationToken,
      attackerEmail,
      String(request.astraUser?.name || attackerEmail.split("@")[0] || "Joueur ASTRAL")
        .trim()
        .slice(0, 160),
      targetEmail,
      defenderName,
      defenderVillageId,
      targetKey,
      JSON.stringify(raidSnapshot),
      goldAvailable,
      manaAvailable,
      startedAt,
    ],
  );

  const pilotVpsRaid = {
    raid_id: raidId,
    token: reservationToken,
    reservation_token: reservationToken,
    attacker_email: attackerEmail,
    attacker_name:
      String(request.astraUser?.name || attackerEmail.split("@")[0] || "Joueur ASTRAL")
        .trim()
        .slice(0, 160),
    defender_email: targetEmail,
    defender_name: defenderName,
    defender_village_id: defenderVillageId,
    target_key: targetKey,
    snapshot: raidSnapshot,
    gold_available: goldAvailable,
    mana_available: manaAvailable,
    started_at: startedAt,
  };

  return {
    ok: true,
    raid_id: raidId,
    token: reservationToken,
    replay_seed: replaySeed,
    target_key: targetKey,
    defender_name: defenderName,
    level: raidSnapshot.player_level,
    trophies: raidSnapshot.trophies,
    gold: goldAvailable,
    mana: manaAvailable,
    buildings,
    defenders,
    removed_obstacles: raidSnapshot.removed_obstacles,
    default_village: !initialized,
    is_bot: false,
    admin_targeted:
      request.body?.admin_targeted === true,
    duration: 300,
    pilot_vps_raid: pilotVpsRaid,
    source: "vps",
  };
});

app.get("/v1/defenses/reports", { preHandler: requireAstraAuth }, async (request) => {
  const defenderEmail = normalizeMirrorEmail(
    request.astraUser.email,
  );

  const [rowsResult, lastRevengeResult] = await Promise.all([
    pool.query(
      `SELECT
         r.*,
         p.display_name AS attacker_display_name,
         p.xp_level AS attacker_xp_level,
         v.snapshot AS attacker_snapshot
       FROM astra_raids r
       LEFT JOIN astra_players p
         ON p.user_email = r.attacker_email
       LEFT JOIN astra_villages v
         ON v.user_email = r.attacker_email
       WHERE r.defender_email = $1
         AND r.status = 'resolved'
       ORDER BY r.resolved_at DESC NULLS LAST,
                r.created_at DESC
       LIMIT 30`,
      [defenderEmail],
    ),
    pool.query(
      `SELECT defender_email
         FROM astra_raids
        WHERE attacker_email = $1
          AND is_revenge = TRUE
          AND status = 'resolved'
        ORDER BY resolved_at DESC NULLS LAST,
                 created_at DESC
        LIMIT 1`,
      [defenderEmail],
    ),
  ]);

  const lastRevengeTarget = normalizeMirrorEmail(
    lastRevengeResult.rows?.[0]?.defender_email,
  );

  const reports = (rowsResult.rows || []).map(
    (raid, index) => {
      const attackerEmail = normalizeMirrorEmail(
        raid?.attacker_email,
      );
      const attackerSnapshot =
        raid?.attacker_snapshot &&
        typeof raid.attacker_snapshot === "object" &&
        !Array.isArray(raid.attacker_snapshot)
          ? raid.attacker_snapshot
          : null;

      let revenge = "unavailable";
      if (
        attackerEmail &&
        !attackerEmail.endsWith(
          "@bots.astra.invalid",
        )
      ) {
        if (
          raid?.revenged_at ||
          raid?.revenge_raid_id
        ) {
          revenge = "done";
        } else if (
          lastRevengeTarget &&
          lastRevengeTarget === attackerEmail
        ) {
          revenge = "consecutive";
        } else if (
          !attackerSnapshot ||
          attackerSnapshot?.initialized !== true
        ) {
          revenge = "unavailable";
        } else {
          const hasRuins = (
            Array.isArray(attackerSnapshot?.buildings)
              ? attackerSnapshot.buildings
              : []
          ).some(
            (building) =>
              building?.stored !== true &&
              (
                building?.ruined === true ||
                Number(building?.hp || 0) <= 0
              ),
          );
          revenge = hasRuins
            ? "protected"
            : "available";
        }
      }

      const stars = Math.max(
        0,
        Number(raid?.stars || 0),
      );
      const replayAvailable =
        index < 3 &&
        raid?.replay &&
        typeof raid.replay === "object" &&
        !Array.isArray(raid.replay);

      return {
        id: String(raid.id),
        attacker_name:
          String(
            raid?.attacker_name ||
              attackerSnapshot?.user_name ||
              raid?.attacker_display_name ||
              attackerEmail?.split("@")[0] ||
              "Sorcier du Voile",
          )
            .trim()
            .slice(0, 160) ||
          "Sorcier du Voile",
        attacker_level: Math.max(
          1,
          Number(
            attackerSnapshot?.player_level ||
              raid?.attacker_xp_level ||
              1,
          ),
        ),
        attacker_trophies: Math.max(
          0,
          Number(attackerSnapshot?.trophies || 0),
        ),
        stars,
        defended: stars === 0,
        destruction_pct: Math.max(
          0,
          Number(raid?.destruction_pct || 0),
        ),
        gold_stolen: Math.max(
          0,
          Number(raid?.gold_stolen || 0),
        ),
        mana_stolen: Math.max(
          0,
          Number(raid?.mana_stolen || 0),
        ),
        credit_lost_cents:
          normalizeMirrorEmail(
            raid?.credit_loser_email,
          ) === defenderEmail
            ? Math.max(
                0,
                Number(
                  raid?.credit_lost_cents || 0,
                ),
              )
            : 0,
        at:
          raid?.resolved_at ||
          raid?.started_at ||
          raid?.created_at ||
          null,
        seen: raid?.defender_seen === true,
        was_revenge: raid?.is_revenge === true,
        replay_available: Boolean(replayAvailable),
        revenge,
        source: "vps",
      };
    },
  );

  return {
    ok: true,
    reports,
    unseen: reports.filter(
      (report) => report.seen !== true,
    ).length,
    source: "vps",
  };
});

app.post("/v1/defenses/replay", { preHandler: requireAstraAuth }, async (request, reply) => {
  const defenderEmail = normalizeMirrorEmail(
    request.astraUser.email,
  );
  const raidId = String(
    request.body?.raid_id || "",
  )
    .trim()
    .slice(0, 180);

  if (!raidId) {
    return reply.code(400).send({
      ok: false,
      error: "Replay introuvable.",
    });
  }

  const rows = await pool.query(
    `SELECT id, snapshot, replay, stars,
            destruction_pct, gold_stolen,
            mana_stolen
       FROM astra_raids
      WHERE defender_email = $1
        AND status = 'resolved'
      ORDER BY resolved_at DESC NULLS LAST,
               created_at DESC
      LIMIT 3`,
    [defenderEmail],
  );

  const raid = (rows.rows || []).find(
    (entry) => String(entry?.id) === raidId,
  );

  if (
    !raid ||
    !raid?.replay ||
    typeof raid.replay !== "object" ||
    Array.isArray(raid.replay)
  ) {
    return reply.code(404).send({
      ok: false,
      error: "Ce replay n’est plus disponible.",
    });
  }

  const snapshot =
    raid?.snapshot &&
    typeof raid.snapshot === "object" &&
    !Array.isArray(raid.snapshot)
      ? raid.snapshot
      : {};

  return {
    ok: true,
    raid_id: String(raid.id),
    replay: {
      ...cloneSnapshot(raid.replay),
      snapshot: {
        buildings: Array.isArray(snapshot?.buildings)
          ? snapshot.buildings
          : [],
        defenders: Array.isArray(snapshot?.defenders)
          ? snapshot.defenders
          : [],
        removed_obstacles: Array.isArray(
          snapshot?.removed_obstacles,
        )
          ? snapshot.removed_obstacles
          : [],
      },
      final: {
        stars: Math.max(
          0,
          Number(raid?.stars || 0),
        ),
        destruction_pct: Math.max(
          0,
          Number(raid?.destruction_pct || 0),
        ),
        gold_stolen: Math.max(
          0,
          Number(raid?.gold_stolen || 0),
        ),
        mana_stolen: Math.max(
          0,
          Number(raid?.mana_stolen || 0),
        ),
      },
    },
    source: "vps",
  };
});

app.post("/v1/defenses/seen", { preHandler: requireAstraAuth }, async (request) => {
  const defenderEmail = normalizeMirrorEmail(
    request.astraUser.email,
  );
  const ids = [
    ...new Set(
      (
        Array.isArray(request.body?.ids)
          ? request.body.ids
          : []
      )
        .slice(0, 40)
        .map((value) =>
          String(value || "").trim().slice(0, 180),
        )
        .filter(Boolean),
    ),
  ];

  if (!ids.length) {
    return {
      ok: true,
      updated: 0,
      source: "vps",
    };
  }

  const result = await pool.query(
    `UPDATE astra_raids
        SET defender_seen = TRUE,
            updated_at = NOW()
      WHERE defender_email = $1
        AND id = ANY($2::text[])
        AND defender_seen = FALSE
      RETURNING id`,
    [defenderEmail, ids],
  );

  return {
    ok: true,
    updated: result.rowCount,
    source: "vps",
  };
});

app.post("/v1/raid/revenge-reserve", { preHandler: requireAstraAuth }, async (request, reply) => {
  const myEmail = normalizeMirrorEmail(
    request.astraUser.email,
  );
  const originRaidId = String(
    request.body?.origin_raid_id || "",
  )
    .trim()
    .slice(0, 180);

  if (!originRaidId) {
    return reply.code(400).send({
      ok: false,
      error: "Attaque introuvable.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const originResult = await client.query(
      `SELECT *
         FROM astra_raids
        WHERE id = $1
          AND defender_email = $2
          AND status = 'resolved'
        LIMIT 1
        FOR UPDATE`,
      [originRaidId, myEmail],
    );

    if (!originResult.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(404).send({
        ok: false,
        error: "Attaque introuvable.",
      });
    }

    const origin = originResult.rows[0];
    const targetEmail = normalizeMirrorEmail(
      origin?.attacker_email,
    );

    if (
      !targetEmail ||
      targetEmail.endsWith("@bots.astra.invalid")
    ) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error:
          "La vengeance n’est pas possible contre ce joueur.",
        revenge: "unavailable",
      });
    }

    if (
      origin?.revenged_at ||
      origin?.revenge_raid_id
    ) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error:
          "Tu t’es déjà vengé de cette attaque.",
        revenge: "done",
      });
    }

    const alreadyResolved = await client.query(
      `SELECT id
         FROM astra_raids
        WHERE attacker_email = $1
          AND revenge_of = $2
          AND status = 'resolved'
        LIMIT 1`,
      [myEmail, originRaidId],
    );
    if (alreadyResolved.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error:
          "Tu t’es déjà vengé de cette attaque.",
        revenge: "done",
      });
    }

    const lastRevenge = await client.query(
      `SELECT defender_email
         FROM astra_raids
        WHERE attacker_email = $1
          AND is_revenge = TRUE
          AND status = 'resolved'
        ORDER BY resolved_at DESC NULLS LAST,
                 created_at DESC
        LIMIT 1`,
      [myEmail],
    );
    if (
      normalizeMirrorEmail(
        lastRevenge.rows?.[0]?.defender_email,
      ) === targetEmail
    ) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error:
          "Tu ne peux pas te venger deux fois de suite du même joueur. Venge-toi d’abord d’un autre attaquant.",
        revenge: "consecutive",
      });
    }

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [targetEmail],
    );

    const targetResult = await client.query(
      `SELECT
         p.display_name,
         p.xp_level,
         p.is_banned,
         v.snapshot
       FROM astra_players p
       LEFT JOIN astra_villages v
         ON v.user_email = p.user_email
       WHERE p.user_email = $1
       LIMIT 1`,
      [targetEmail],
    );

    if (
      !targetResult.rowCount ||
      targetResult.rows[0]?.is_banned === true
    ) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error:
          "La vengeance n’est pas possible contre ce joueur.",
        revenge: "unavailable",
      });
    }

    const row = targetResult.rows[0];
    const targetSnapshot =
      row?.snapshot &&
      typeof row.snapshot === "object" &&
      !Array.isArray(row.snapshot)
        ? cloneSnapshot(row.snapshot)
        : {};

    if (targetSnapshot?.initialized !== true) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error:
          "La vengeance n’est pas possible contre ce joueur.",
        revenge: "unavailable",
      });
    }

    const buildings =
      normalizeRaidBuildingsVps(targetSnapshot);
    const hasRuins = buildings.some(
      (building) =>
        building?.stored !== true &&
        (
          building?.ruined === true ||
          Number(building?.hp || 0) <= 0
        ),
    );
    if (hasRuins) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error:
          "Ce joueur est protégé pour l’instant (son village est en ruines). Réessaie plus tard.",
        revenge: "protected",
      });
    }

    if (
      !buildings.some(
        (building) =>
          building?.stored !== true &&
          building?.ruined !== true &&
          Number(building?.hp || 0) > 0 &&
          building?.type !== "wall",
      )
    ) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error:
          "La vengeance n’est pas possible contre ce joueur.",
        revenge: "unavailable",
      });
    }

    const defenders = defenderPositionsVps(
      buildings,
      targetSnapshot?.defenders,
    );
    const resources =
      targetSnapshot?.resources &&
      typeof targetSnapshot.resources === "object" &&
      !Array.isArray(targetSnapshot.resources)
        ? targetSnapshot.resources
        : {};

    const goldAvailable = Math.floor(
      Math.max(0, Number(resources?.gold || 0)) *
        0.25,
    );
    const manaAvailable = Math.floor(
      Math.max(0, Number(resources?.mana || 0)) *
        0.25,
    );

    const reservationToken = crypto.randomUUID();
    const raidId = crypto.randomUUID();
    const replaySeed = secureRandomIntVps(
      1,
      2_147_483_646,
    );
    const startedAt = new Date().toISOString();
    const defenderName =
      String(
        targetSnapshot?.user_name ||
          row?.display_name ||
          origin?.attacker_name ||
          targetEmail.split("@")[0] ||
          "Joueur ASTRAL",
      )
        .trim()
        .slice(0, 160) || "Joueur ASTRAL";

    const raidSnapshot = {
      target_type: "player",
      replay_seed: replaySeed,
      buildings,
      defenders,
      removed_obstacles: Array.isArray(
        targetSnapshot?.removed_obstacles,
      )
        ? targetSnapshot.removed_obstacles.slice(0, 600)
        : [],
      initialized: true,
      player_level: Math.max(
        1,
        Number(
          targetSnapshot?.player_level ||
            row?.xp_level ||
            1,
        ),
      ),
      trophies: Math.max(
        0,
        Number(targetSnapshot?.trophies || 0),
      ),
      revenge_of: originRaidId,
      vps_reserved: true,
    };

    await client.query(
      `INSERT INTO astra_raids
         (id, reservation_token, attacker_email,
          attacker_name, defender_email,
          defender_name, defender_village_id,
          target_key, snapshot, status,
          gold_available, mana_available,
          is_revenge, revenge_of,
          started_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8,
          $9::jsonb, 'reserved', $10, $11,
          TRUE, $12, $13, NOW())`,
      [
        raidId,
        reservationToken,
        myEmail,
        String(
          request.astraUser?.name ||
            myEmail.split("@")[0] ||
            "Joueur ASTRAL",
        )
          .trim()
          .slice(0, 160),
        targetEmail,
        defenderName,
        String(
          targetSnapshot?.id || targetEmail,
        )
          .trim()
          .slice(0, 180),
        `revenge:${originRaidId}`,
        JSON.stringify(raidSnapshot),
        goldAvailable,
        manaAvailable,
        originRaidId,
        startedAt,
      ],
    );

    await client.query("COMMIT");

    const pilotVpsRaid = {
      raid_id: raidId,
      token: reservationToken,
      reservation_token: reservationToken,
      attacker_email: myEmail,
      attacker_name: String(
        request.astraUser?.name ||
          myEmail.split("@")[0] ||
          "Joueur ASTRAL",
      )
        .trim()
        .slice(0, 160),
      defender_email: targetEmail,
      defender_name: defenderName,
      defender_village_id: String(
        targetSnapshot?.id || targetEmail,
      )
        .trim()
        .slice(0, 180),
      target_key: `revenge:${originRaidId}`,
      snapshot: raidSnapshot,
      gold_available: goldAvailable,
      mana_available: manaAvailable,
      revenge_of: originRaidId,
      started_at: startedAt,
    };

    return {
      ok: true,
      raid_id: raidId,
      token: reservationToken,
      replay_seed: replaySeed,
      target_key: `revenge:${originRaidId}`,
      defender_name: defenderName,
      level: raidSnapshot.player_level,
      trophies: raidSnapshot.trophies,
      gold: goldAvailable,
      mana: manaAvailable,
      buildings,
      defenders,
      removed_obstacles:
        raidSnapshot.removed_obstacles,
      default_village: false,
      is_bot: false,
      is_revenge: true,
      pilot_vps_raid: pilotVpsRaid,
      source: "vps",
      duration: 300,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/raid/cancel", { preHandler: requireAstraAuth }, async (request, reply) => {
  const attackerEmail = normalizeMirrorEmail(
    request.astraUser.email,
  );
  const token = String(
    request.body?.token || "",
  )
    .trim()
    .slice(0, 180);

  if (!token) {
    return reply.code(400).send({
      ok: false,
      error: "Jeton de raid manquant.",
    });
  }

  const result = await pool.query(
    `UPDATE astra_raids
        SET status = 'canceled',
            canceled_at = NOW(),
            updated_at = NOW()
      WHERE attacker_email = $1
        AND reservation_token = $2
        AND status = 'reserved'
      RETURNING id`,
    [attackerEmail, token],
  );

  return {
    ok: true,
    canceled: result.rowCount > 0,
    source: "vps",
  };
});

app.post("/v1/raid/resolve", { preHandler: requireAstraAuth }, async (request, reply) => {
  const attackerEmail = normalizeMirrorEmail(
    request.astraUser.email,
  );
  const token = String(request.body?.token || "")
    .trim()
    .slice(0, 180);

  if (!token) {
    return reply.code(400).send({
      ok: false,
      error: "Jeton de raid manquant.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const raidResult = await client.query(
      `SELECT *
         FROM astra_raids
        WHERE attacker_email = $1
          AND reservation_token = $2
        LIMIT 1
        FOR UPDATE`,
      [attackerEmail, token],
    );

    if (!raidResult.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(404).send({
        ok: false,
        error: "Raid introuvable.",
      });
    }

    const raid = raidResult.rows[0];
    const raidSnapshot =
      raid?.snapshot &&
      typeof raid.snapshot === "object" &&
      !Array.isArray(raid.snapshot)
        ? cloneSnapshot(raid.snapshot)
        : {};

    if (raidSnapshot?.target_type !== "player") {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error:
          "Ce type de raid reste temporairement géré par Base44.",
      });
    }

    const defenderEmail = normalizeMirrorEmail(
      raid.defender_email,
    );
    if (!defenderEmail) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error: "Défenseur invalide.",
      });
    }

    for (const email of [
      attackerEmail,
      defenderEmail,
    ].sort()) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [email],
      );
    }

    const villages = await client.query(
      `SELECT user_email, revision, snapshot
         FROM astra_villages
        WHERE user_email = ANY($1::text[])
        FOR UPDATE`,
      [[attackerEmail, defenderEmail]],
    );

    const villageMap = new Map(
      (villages.rows || []).map((row) => [
        normalizeMirrorEmail(row.user_email),
        row,
      ]),
    );
    const attackerRow = villageMap.get(attackerEmail);
    const defenderRow = villageMap.get(defenderEmail);

    if (!attackerRow || !defenderRow) {
      await client.query("ROLLBACK");
      return reply.code(404).send({
        ok: false,
        error: "Village introuvable.",
      });
    }

    const attackerSnapshot = cloneSnapshot(
      attackerRow.snapshot,
    );
    const defenderSnapshot = cloneSnapshot(
      defenderRow.snapshot,
    );

    const responseFromResolved = () => {
      const stars = Math.max(
        0,
        Number(raid.stars || 0),
      );
      const won = stars > 0;
      const attackerBalance = won
        ? Math.max(
            0,
            Number(
              raid.credit_winner_balance_after_cents ||
                0,
            ),
          )
        : Math.max(
            0,
            Number(
              raid.credit_loser_balance_after_cents ||
                0,
            ),
          );
      return {
        ok: true,
        defender_name: String(
          raid.defender_name || "",
        ),
        stars,
        destruction_pct: Math.max(
          0,
          Number(raid.destruction_pct || 0),
        ),
        gold_stolen: Math.max(
          0,
          Number(raid.gold_stolen || 0),
        ),
        mana_stolen: Math.max(
          0,
          Number(raid.mana_stolen || 0),
        ),
        credit_gain_cents: Math.max(
          0,
          Number(raid.credit_gain_cents || 0),
        ),
        credit_loss_pct: Math.max(
          0,
          Number(raid.credit_loss_pct || 0),
        ),
        credit_lost_cents: Math.max(
          0,
          Number(raid.credit_lost_cents || 0),
        ),
        attacker_credit_delta_cents: won
          ? Math.max(
              0,
              Number(raid.credit_gain_cents || 0),
            )
          : -Math.max(
              0,
              Number(raid.credit_lost_cents || 0),
            ),
        attacker_credit_balance_after_cents:
          attackerBalance,
        attacker_gold_after: Math.max(
          0,
          Number(
            attackerSnapshot?.resources?.gold || 0,
          ),
        ),
        attacker_mana_after: Math.max(
          0,
          Number(
            attackerSnapshot?.resources?.mana || 0,
          ),
        ),
        raid_chest: String(
          raidSnapshot?.attacker_chest_reward || "",
        ),
        village: attackerSnapshot,
        revision: Number(attackerRow.revision || 0),
        source: "vps",
      };
    };

    if (raid.status === "resolved") {
      await client.query("COMMIT");
      return responseFromResolved();
    }

    if (raid.status !== "reserved") {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error: "Ce raid a expiré.",
      });
    }

    const destruction =
      Math.round(
        clampNumberVps(
          request.body?.destruction_pct,
          0,
          100,
        ) * 10,
      ) / 10;
    const claimedStars = Math.round(
      clampNumberVps(
        request.body?.stars,
        0,
        3,
      ),
    );
    const stars =
      destruction < 50
        ? 0
        : Math.max(1, claimedStars);
    const won = stars > 0;
    const lootRatio = clampNumberVps(
      destruction / 100,
      0,
      1,
    );

    const defenderResources = ensureSnapshotResources(
      defenderSnapshot,
    );
    const attackerResources = ensureSnapshotResources(
      attackerSnapshot,
    );
    const goldPool = Math.min(
      Math.max(
        0,
        Number(raid.gold_available || 0),
      ),
      Math.max(
        0,
        Number(defenderResources.gold || 0),
      ),
    );
    const manaPool = Math.min(
      Math.max(
        0,
        Number(raid.mana_available || 0),
      ),
      Math.max(
        0,
        Number(defenderResources.mana || 0),
      ),
    );

    const goldStolen = won
      ? Math.floor(goldPool * lootRatio)
      : 0;
    const manaStolen = won
      ? Math.floor(manaPool * lootRatio)
      : 0;

    const reservedBuildings = Array.isArray(
      raidSnapshot?.buildings,
    )
      ? raidSnapshot.buildings
      : [];
    const requestedDestroyed = [
      ...new Set(
        (
          Array.isArray(
            request.body?.destroyed_building_ids,
          )
            ? request.body.destroyed_building_ids
            : []
        )
          .slice(0, MAX_RAID_BUILDINGS_VPS)
          .map(String),
      ),
    ];
    const destroyedBuildingIds =
      requestedDestroyed.filter((id) =>
        reservedBuildings.some(
          (building) =>
            String(building?.id) === id &&
            building?.stored !== true &&
            building?.ruined !== true &&
            Number(building?.hp || 0) > 0,
        ),
      );

    const replay = normalizeRaidReplayVps(
      request.body?.replay,
      raidSnapshot,
    );
    const creditGainCents = stableRollVps(
      token,
      1,
      5,
      "gain",
    );
    const creditLossPct = stableRollVps(
      token,
      1,
      15,
      "loss",
    );

    const creditWinnerEmail = won
      ? attackerEmail
      : defenderEmail;
    const creditLoserEmail = won
      ? defenderEmail
      : attackerEmail;
    const creditWinnerName = won
      ? String(raid.attacker_name || "")
      : String(raid.defender_name || "");
    const creditLoserName = won
      ? String(raid.defender_name || "")
      : String(raid.attacker_name || "");

    let creditLostCents = 0;
    let creditWinnerBalanceAfter = 0;
    let creditLoserBalanceAfter = 0;
    let creditSettled = false;

    const creditMigrationReadyResult =
      await client.query(
        `SELECT value
           FROM astra_settings
          WHERE setting_key =
            'astra_credit_migration'
          LIMIT 1`,
      );
    const creditMigrationReady =
      creditMigrationReadyResult.rows?.[0]?.value
        ?.ready === true;

    const creditMigration = await client.query(
      `SELECT user_email, imported_at
         FROM astra_credit_wallets
        WHERE user_email = ANY($1::text[])`,
      [[creditWinnerEmail, creditLoserEmail]],
    );
    const importedCreditEmails = new Set(
      (creditMigration.rows || [])
        .filter((row) => row?.imported_at)
        .map((row) =>
          normalizeMirrorEmail(row.user_email),
        ),
    );

    if (
      creditMigrationReady ||
      (
        importedCreditEmails.has(
          creditWinnerEmail,
        ) &&
        importedCreditEmails.has(
          creditLoserEmail,
        )
      )
    ) {
      const creditEventBase =
        "ASTRA_RAID_CREDIT:" +
        String(raid.id || token);

      const loserWallet =
        await ensureCreditWalletTx(
          client,
          creditLoserEmail,
          creditLoserName,
        );
      const loserBalance = Math.max(
        0,
        Math.round(
          Number(loserWallet.balance_cents || 0),
        ),
      );
      creditLostCents =
        loserBalance > 0
          ? Math.min(
              loserBalance,
              Math.max(
                1,
                Math.floor(
                  (loserBalance * creditLossPct) /
                    100,
                ),
              ),
            )
          : 0;

      const lossSettlement =
        creditLostCents > 0
          ? await applyCreditDeltaTx(client, {
              email: creditLoserEmail,
              name: creditLoserName,
              deltaCents: -creditLostCents,
              eventKey:
                creditEventBase + ":loss",
              reason: "raid_loss",
              refId: String(raid.id || token),
            })
          : {
              wallet: loserWallet,
              appliedCents: 0,
            };

      const winSettlement =
        await applyCreditDeltaTx(client, {
          email: creditWinnerEmail,
          name: creditWinnerName,
          deltaCents: creditGainCents,
          eventKey: creditEventBase + ":win",
          reason: "raid_win",
          refId: String(raid.id || token),
        });

      creditLoserBalanceAfter = Math.max(
        0,
        Math.round(
          Number(
            lossSettlement.wallet?.balance_cents ||
              0,
          ),
        ),
      );
      creditWinnerBalanceAfter = Math.max(
        0,
        Math.round(
          Number(
            winSettlement.wallet?.balance_cents ||
              0,
          ),
        ),
      );
      creditSettled = true;
    }

    const { config: adminConfig } =
      await loadVpsAdminConfig();
    const raidChestChance = clampNumberVps(
      adminConfig?.economy?.raidChestChance ?? 40,
      0,
      100,
    );
    const raidChestReward =
      won &&
      stableRollVps(
        token,
        1,
        100,
        "raid-chest",
      ) <= raidChestChance
        ? stars === 3
          ? "rareChest"
          : "chest"
        : "";

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    const defenderSiege =
      defenderSnapshot?.siege &&
      typeof defenderSnapshot.siege === "object" &&
      !Array.isArray(defenderSnapshot.siege)
        ? { ...defenderSnapshot.siege }
        : {};
    const nextSiege = {
      revision:
        Math.max(
          0,
          Math.floor(
            Number(defenderSiege.revision || 0),
          ),
        ) + 1,
      goldDebits:
        Math.max(
          0,
          Number(defenderSiege.goldDebits || 0),
        ) + goldStolen,
      manaDebits:
        Math.max(
          0,
          Number(defenderSiege.manaDebits || 0),
        ) + manaStolen,
    };

    defenderSnapshot.buildings =
      defenderSnapshot.initialized === true
        ? settleRaidBuildingDamageVps(
            Array.isArray(defenderSnapshot.buildings)
              ? defenderSnapshot.buildings
              : [],
            reservedBuildings,
            destroyedBuildingIds,
            nextSiege.revision,
            nowMs,
          )
        : defaultRaidBuildingsVps();
    defenderResources.gold = Math.max(
      0,
      Math.floor(
        Number(defenderResources.gold || 0) -
          goldStolen,
      ),
    );
    defenderResources.mana = Math.max(
      0,
      Math.floor(
        Number(defenderResources.mana || 0) -
          manaStolen,
      ),
    );
    defenderSnapshot.resources =
      defenderResources;
    defenderSnapshot.siege = nextSiege;
    defenderSnapshot.defenses_won =
      Math.max(
        0,
        Number(defenderSnapshot.defenses_won || 0),
      ) + (won ? 0 : 1);
    defenderSnapshot.defenses_lost =
      Math.max(
        0,
        Number(defenderSnapshot.defenses_lost || 0),
      ) + (won ? 1 : 0);
    defenderSnapshot.synced_at = nowIso;

    attackerResources.gold = Math.min(
      MAX_RESOURCE,
      Math.floor(
        Number(attackerResources.gold || 0) +
          goldStolen,
      ),
    );
    attackerResources.mana = Math.min(
      MAX_RESOURCE,
      Math.floor(
        Number(attackerResources.mana || 0) +
          manaStolen,
      ),
    );
    attackerSnapshot.resources =
      attackerResources;

    const attackerInventory =
      snapshotInventory(attackerSnapshot);
    if (
      raidChestReward &&
      SECURE_CHEST_IDS.has(raidChestReward)
    ) {
      attackerInventory[raidChestReward] =
        Math.min(
          MAX_RESOURCE,
          clampInt(
            attackerInventory[raidChestReward],
            0,
            MAX_RESOURCE,
          ) + 1,
        );
    }
    attackerSnapshot.inventory =
      attackerInventory;

    const recentTargets = (
      Array.isArray(attackerSnapshot.recent_targets)
        ? attackerSnapshot.recent_targets
        : []
    )
      .map(normalizeMirrorEmail)
      .filter(
        (email) =>
          email &&
          email !== defenderEmail,
      );
    attackerSnapshot.recent_targets = [
      ...recentTargets,
      defenderEmail,
    ].slice(-5);
    attackerSnapshot.raids_won =
      Math.max(
        0,
        Number(attackerSnapshot.raids_won || 0),
      ) + (won ? 1 : 0);
    attackerSnapshot.raids_lost =
      Math.max(
        0,
        Number(attackerSnapshot.raids_lost || 0),
      ) + (won ? 0 : 1);
    attackerSnapshot.last_raid_at = nowIso;
    attackerSnapshot.synced_at = nowIso;

    const resolvedRaidSnapshot = {
      ...raidSnapshot,
      destroyed_building_ids:
        destroyedBuildingIds,
      attacker_chest_reward: raidChestReward,
    };

    const pilotResolution = {
      vps_raid_id: String(raid.id || ""),
      stars,
      destruction_pct: destruction,
      gold_stolen: goldStolen,
      mana_stolen: manaStolen,
      destroyed_building_ids:
        destroyedBuildingIds,
      raid_chest: raidChestReward,
      credit_gain_cents: creditGainCents,
      credit_loss_pct: creditLossPct,
      credit_lost_cents: creditLostCents,
      credit_winner_email: creditWinnerEmail,
      credit_loser_email: creditLoserEmail,
      credit_settled: creditSettled,
      credit_winner_balance_after_cents:
        creditWinnerBalanceAfter,
      credit_loser_balance_after_cents:
        creditLoserBalanceAfter,
      replay,
      resolved_at: nowIso,
    };

    markVpsBackupPending(
      attackerSnapshot,
      nowIso,
      {
        action: "resolveRaid",
        token,
        stars,
        destruction_pct: destruction,
        destroyed_building_ids:
          destroyedBuildingIds,
        ...(replay ? { replay } : {}),
        pilot_vps_backup: true,
        pilot_vps_resolution:
          pilotResolution,
      },
    );

    const attackerRevision =
      Number(attackerRow.revision || 0) + 1;
    const defenderRevision =
      Number(defenderRow.revision || 0) + 1;

    await client.query(
      `UPDATE astra_villages
          SET revision = $2,
              snapshot = $3::jsonb,
              updated_at = NOW()
        WHERE user_email = $1`,
      [
        attackerEmail,
        attackerRevision,
        JSON.stringify(attackerSnapshot),
      ],
    );
    await client.query(
      `UPDATE astra_villages
          SET revision = $2,
              snapshot = $3::jsonb,
              updated_at = NOW()
        WHERE user_email = $1`,
      [
        defenderEmail,
        defenderRevision,
        JSON.stringify(defenderSnapshot),
      ],
    );

    await client.query(
      `UPDATE astra_raids
          SET status = 'resolved',
              snapshot = $3::jsonb,
              settlement_started_at = NOW(),
              gold_stolen = $4,
              mana_stolen = $5,
              stars = $6,
              destruction_pct = $7,
              credit_gain_cents = $8,
              credit_loss_pct = $9,
              credit_winner_email = $10,
              credit_loser_email = $11,
              replay = $12::jsonb,
              credit_lost_cents = $13,
              credit_settled = $14,
              credit_winner_balance_after_cents = $15,
              credit_loser_balance_after_cents = $16,
              resolved_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND reservation_token = $2`,
      [
        raid.id,
        token,
        JSON.stringify(resolvedRaidSnapshot),
        goldStolen,
        manaStolen,
        stars,
        destruction,
        creditGainCents,
        creditLossPct,
        creditWinnerEmail,
        creditLoserEmail,
        replay ? JSON.stringify(replay) : null,
        creditLostCents,
        creditSettled,
        creditWinnerBalanceAfter,
        creditLoserBalanceAfter,
      ],
    );

    if (
      raid?.is_revenge === true &&
      String(raid?.revenge_of || "").trim()
    ) {
      await client.query(
        `UPDATE astra_raids
            SET revenged_at = NOW(),
                revenge_raid_id = $2,
                updated_at = NOW()
          WHERE id = $1
            AND defender_email = $3
            AND status = 'resolved'`,
        [
          String(raid.revenge_of),
          String(raid.id),
          attackerEmail,
        ],
      );
    }

    await client.query("COMMIT");

    return {
      ok: true,
      defender_name: String(
        raid.defender_name || "",
      ),
      stars,
      destruction_pct: destruction,
      gold_stolen: goldStolen,
      mana_stolen: manaStolen,
      credit_gain_cents: creditGainCents,
      credit_loss_pct: creditLossPct,
      credit_lost_cents: creditLostCents,
      attacker_credit_delta_cents: creditSettled
        ? won
          ? creditGainCents
          : -creditLostCents
        : 0,
      attacker_credit_balance_after_cents:
        creditSettled
          ? won
            ? creditWinnerBalanceAfter
            : creditLoserBalanceAfter
          : 0,
      credit_settled: creditSettled,
      attacker_gold_after: Math.max(
        0,
        Number(attackerResources.gold || 0),
      ),
      attacker_mana_after: Math.max(
        0,
        Number(attackerResources.mana || 0),
      ),
      raid_chest: raidChestReward,
      bounty_rewards: [],
      village: attackerSnapshot,
      revision: attackerRevision,
      pilot_vps_resolution: pilotResolution,
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/credits/state", { preHandler: requireAstraAuth }, async (request) => {
  const email = normalizeMirrorEmail(
    request.astraUser.email,
  );
  const result = await pool.query(
    `SELECT *
       FROM astra_credit_wallets
      WHERE user_email = $1
      LIMIT 1`,
    [email],
  );
  const wallet = result.rows?.[0] || {
    balance_cents: 0,
    lifetime_cents: 0,
  };
  return {
    ok: true,
    credit: creditSnapshotVps(wallet),
    source: "vps",
  };
});

app.post("/v1/credits/redeem", { preHandler: requireAstraAuth }, async (request, reply) => {
  const email = normalizeMirrorEmail(
    request.astraUser.email,
  );
  const name = String(
    request.astraUser?.name ||
      request.astraUser?.full_name ||
      email.split("@")[0] ||
      "",
  )
    .trim()
    .slice(0, 160);
  const redeemKey = String(
    request.body?.redeem_key || "",
  )
    .trim()
    .slice(0, 120);

  if (!redeemKey) {
    return reply.code(400).send({
      ok: false,
      error: "Demande d’échange invalide.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [email],
    );

    const existing = await client.query(
      `SELECT *
         FROM astra_credit_redemptions
        WHERE user_email = $1
          AND redeem_key = $2
        LIMIT 1`,
      [email, redeemKey],
    );

    if (existing.rowCount) {
      const wallet = await ensureCreditWalletTx(
        client,
        email,
        name,
      );
      await client.query("COMMIT");
      const row = existing.rows[0];
      return {
        ok: true,
        duplicate: true,
        code: row.code,
        promo: {
          code: row.code,
          source_reward_id: row.source_id,
          wheel_name: "Crédit Sorcier",
          reward_label:
            "50 € de réduction — Crédit Sorcier",
          discount_type: "fixed",
          discount_value:
            SORCERER_CREDIT_REDEEM_EUROS_VPS,
          status: row.status || "active",
        },
        exchangedCents:
          SORCERER_CREDIT_REDEEM_CENTS_VPS,
        exchangedEuros:
          SORCERER_CREDIT_REDEEM_EUROS_VPS,
        credit: creditSnapshotVps(wallet),
        source: "vps",
      };
    }

    const wallet = await ensureCreditWalletTx(
      client,
      email,
      name,
    );
    const balance = Math.max(
      0,
      Math.round(Number(wallet.balance_cents || 0)),
    );

    if (
      balance <
      SORCERER_CREDIT_REDEEM_CENTS_VPS
    ) {
      await client.query("ROLLBACK");
      return reply.code(400).send({
        ok: false,
        error:
          "Il faut 50,00 € de Crédit Sorcier pour créer ce code promo.",
        requiredCents:
          SORCERER_CREDIT_REDEEM_CENTS_VPS,
        missingCents:
          SORCERER_CREDIT_REDEEM_CENTS_VPS -
          balance,
        credit: creditSnapshotVps(wallet),
      });
    }

    const sourceId =
      "sorcerer_credit_exchange:" + redeemKey;
    const eventKey =
      "WIZARD_CREDIT_REDEEM:" + redeemKey;
    const code = sorcererExchangeCodeVps(
      email,
      redeemKey,
    );

    const debit = await applyCreditDeltaTx(
      client,
      {
        email,
        name,
        deltaCents:
          -SORCERER_CREDIT_REDEEM_CENTS_VPS,
        eventKey,
        reason: "redeem",
        refId: sourceId,
      },
    );

    await client.query(
      `INSERT INTO astra_credit_redemptions
         (user_email, redeem_key, source_id,
          code, status, created_at)
       VALUES ($1, $2, $3, $4, 'active', NOW())`,
      [email, redeemKey, sourceId, code],
    );

    await client.query("COMMIT");

    return {
      ok: true,
      code,
      promo: {
        code,
        source_reward_id: sourceId,
        wheel_name: "Crédit Sorcier",
        reward_label:
          "50 € de réduction — Crédit Sorcier",
        discount_type: "fixed",
        discount_value:
          SORCERER_CREDIT_REDEEM_EUROS_VPS,
        status: "active",
      },
      exchangedCents:
        SORCERER_CREDIT_REDEEM_CENTS_VPS,
      exchangedEuros:
        SORCERER_CREDIT_REDEEM_EUROS_VPS,
      credit: creditSnapshotVps(debit.wallet),
      source: "vps",
      backup: {
        action: "redeemSorcererCredit",
        redeemKey,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/admin/credits/status", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const migration = await pool.query(
    `SELECT value, updated_at
       FROM astra_settings
      WHERE setting_key =
        'astra_credit_migration'
      LIMIT 1`,
  );
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS wallets,
       COUNT(*) FILTER (
         WHERE imported_at IS NOT NULL
       )::int AS imported,
       COALESCE(SUM(balance_cents), 0)::bigint
         AS total_balance_cents
     FROM astra_credit_wallets`,
  );
  const events = await pool.query(
    `SELECT COUNT(*)::int AS events
       FROM astra_credit_events`,
  );
  const redemptions = await pool.query(
    `SELECT COUNT(*)::int AS redemptions
       FROM astra_credit_redemptions`,
  );

  return {
    ok: true,
    wallets: Number(
      result.rows?.[0]?.wallets || 0,
    ),
    imported: Number(
      result.rows?.[0]?.imported || 0,
    ),
    total_balance_cents: Number(
      result.rows?.[0]?.total_balance_cents || 0,
    ),
    events: Number(
      events.rows?.[0]?.events || 0,
    ),
    redemptions: Number(
      redemptions.rows?.[0]?.redemptions || 0,
    ),
    migration_ready:
      migration.rows?.[0]?.value?.ready === true,
    migration_updated_at:
      migration.rows?.[0]?.updated_at || null,
    source: "vps",
  };
});

app.post("/v1/admin/credits/import", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const profiles = (
    Array.isArray(request.body?.profiles)
      ? request.body.profiles
      : []
  ).slice(0, 500);
  const redemptions = (
    Array.isArray(request.body?.redemptions)
      ? request.body.redemptions
      : []
  ).slice(0, 500);
  const final = request.body?.final === true;

  const client = await pool.connect();
  let imported = 0;
  let skipped = 0;
  let importedRedemptions = 0;

  try {
    await client.query("BEGIN");

    for (const profile of profiles) {
      const email = normalizeMirrorEmail(
        profile?.user_email,
      );
      if (!email) {
        skipped += 1;
        continue;
      }

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [email],
      );

      const existing = await client.query(
        `SELECT *,
          (SELECT COUNT(*)::int
             FROM astra_credit_events e
            WHERE e.user_email =
              astra_credit_wallets.user_email)
            AS event_count
           FROM astra_credit_wallets
          WHERE user_email = $1
          LIMIT 1
          FOR UPDATE`,
        [email],
      );

      const row = existing.rows?.[0];
      if (
        row &&
        (
          row.imported_at ||
          Number(row.event_count || 0) > 0
        )
      ) {
        skipped += 1;
        continue;
      }

      const balance = Math.max(
        0,
        Math.round(
          Number(
            profile?.sorcerer_credit_cents || 0,
          ),
        ),
      );
      const lifetime = Math.max(
        balance,
        Math.round(
          Number(
            profile?.sorcerer_credit_lifetime_cents ||
              balance,
          ),
        ),
      );
      const name = String(
        profile?.user_name || "",
      )
        .trim()
        .slice(0, 160);

      await client.query(
        `INSERT INTO astra_credit_wallets
           (user_email, user_name,
            balance_cents, lifetime_cents,
            imported_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (user_email)
         DO UPDATE SET
           user_name = EXCLUDED.user_name,
           balance_cents =
             EXCLUDED.balance_cents,
           lifetime_cents =
             EXCLUDED.lifetime_cents,
           imported_at = NOW(),
           updated_at = NOW()`,
        [email, name, balance, lifetime],
      );
      imported += 1;
    }

    for (const promo of redemptions) {
      const email = normalizeMirrorEmail(
        promo?.user_email,
      );
      const sourceId = String(
        promo?.source_reward_id || "",
      )
        .trim()
        .slice(0, 180);
      const prefix =
        "sorcerer_credit_exchange:";
      if (
        !email ||
        !sourceId.startsWith(prefix) ||
        !promo?.code
      ) {
        continue;
      }

      const redeemKey = sourceId
        .slice(prefix.length)
        .slice(0, 120);
      if (!redeemKey) continue;

      await client.query(
        `INSERT INTO astra_credit_redemptions
           (user_email, redeem_key, source_id,
            code, status, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_email, redeem_key)
         DO NOTHING`,
        [
          email,
          redeemKey,
          sourceId,
          String(promo.code).slice(0, 120),
          ["active", "used", "expired"].includes(
            String(promo?.status || ""),
          )
            ? String(promo.status)
            : "active",
        ],
      );
      importedRedemptions += 1;
    }

    if (final) {
      await client.query(
        `INSERT INTO astra_settings
           (setting_key, revision, value,
            updated_at)
         VALUES
           ('astra_credit_migration', 1,
            $1::jsonb, NOW())
         ON CONFLICT (setting_key)
         DO UPDATE SET
           revision =
             astra_settings.revision + 1,
           value = EXCLUDED.value,
           updated_at = NOW()`,
        [
          JSON.stringify({
            ready: true,
            completed_at:
              new Date().toISOString(),
          }),
        ],
      );
    }

    await client.query("COMMIT");
    return {
      ok: true,
      imported,
      skipped,
      imported_redemptions:
        importedRedemptions,
      migration_ready: final,
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/daily-gift/claim", { preHandler: requireAstraAuth }, async (request, reply) => {
  const user = request.astraUser;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT revision, snapshot
         FROM astra_villages
        WHERE user_email = $1
        FOR UPDATE`,
      [user.email],
    );

    if (!current.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ ok: false, error: "Village introuvable." });
    }

    const row = current.rows[0];
    const revision = Number(row.revision || 0);
    const snapshot =
      row.snapshot && typeof row.snapshot === "object" && !Array.isArray(row.snapshot)
        ? JSON.parse(JSON.stringify(row.snapshot))
        : {};

    const today = parisDateKey();
    const daily = normalizeDailyProgress(snapshot.daily_progress, today);

    if (daily.claimed.includes("dailyGift")) {
      await client.query("COMMIT");
      return {
        ok: true,
        granted: false,
        already_claimed: true,
        daily,
        village: snapshot,
        revision,
        source: "vps",
      };
    }

    daily.claimed.push("dailyGift");

    const resources =
      snapshot.resources && typeof snapshot.resources === "object" && !Array.isArray(snapshot.resources)
        ? { ...snapshot.resources }
        : {};
    resources.gems = Math.min(MAX_GEMS, clampInt(resources.gems, 0, MAX_GEMS) + 15);
    resources.gems_revision = Math.min(
      MAX_RESOURCE,
      clampInt(resources.gems_revision, 0, MAX_RESOURCE) + 1,
    );
    resources.gems_initialized = true;

    const inventory =
      snapshot.inventory && typeof snapshot.inventory === "object" && !Array.isArray(snapshot.inventory)
        ? { ...snapshot.inventory }
        : {};
    inventory.chest = Math.min(MAX_RESOURCE, clampInt(inventory.chest, 0, MAX_RESOURCE) + 1);

    const now = new Date().toISOString();
    const nextSnapshot = markVpsBackupPending({
      ...snapshot,
      daily_progress: daily,
      inventory,
      resources,
      progression_version: Math.max(4, Number(snapshot.progression_version || 0)),
      last_active_at: now,
      synced_at: now,
    }, now, { action: "claimDailyGift" });

    const nextRevision = revision + 1;
    await client.query(
      `UPDATE astra_villages
          SET revision = $2,
              snapshot = $3::jsonb,
              updated_at = NOW()
        WHERE user_email = $1`,
      [user.email, nextRevision, JSON.stringify(nextSnapshot)],
    );

    await client.query("COMMIT");
    return {
      ok: true,
      granted: true,
      already_claimed: false,
      daily,
      village: nextSnapshot,
      revision: nextRevision,
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/achievements/claim", { preHandler: requireAstraAuth }, async (request, reply) => {
  const achievementId = String(request.body?.achievement_id || "").trim().slice(0, 120);
  const achievement = VPS_ACHIEVEMENTS[achievementId];
  if (!achievement) {
    return reply.code(404).send({ ok: false, error: "Succès invalide." });
  }

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const claimed = Array.isArray(snapshot.achievements_progress)
      ? [...new Set(snapshot.achievements_progress.map((value) => String(value || "")).filter(Boolean))].slice(0, 1000)
      : [];

    const localReward = achievement.reward?.fragment
      ? { fragment: Math.max(0, Math.floor(Number(achievement.reward.fragment || 0))) }
      : {};

    if (claimed.includes(achievementId)) {
      return {
        write: false,
        response: {
          ok: true,
          granted: false,
          already_claimed: true,
          local_reward: localReward,
        },
      };
    }

    const stats =
      snapshot.stats_progress && typeof snapshot.stats_progress === "object" && !Array.isArray(snapshot.stats_progress)
        ? snapshot.stats_progress
        : {};
    if (Number(stats[achievement.stat] || 0) < Number(achievement.goal || 1)) {
      throw makeHttpError(409, "Objectif du succès non atteint.");
    }

    const sensitiveReward = {};
    if (achievement.reward?.gems) {
      const amount = Math.max(0, Math.floor(Number(achievement.reward.gems || 0)));
      addSnapshotGems(snapshot, amount);
      sensitiveReward.gems = amount;
    }
    if (achievement.reward?.legendChest) {
      const inventory = snapshotInventory(snapshot);
      const amount = Math.max(0, Math.floor(Number(achievement.reward.legendChest || 0)));
      inventory.legendChest = Math.min(
        MAX_RESOURCE,
        clampInt(inventory.legendChest, 0, MAX_RESOURCE) + amount,
      );
      snapshot.inventory = inventory;
      sensitiveReward.legendChest = amount;
    }

    const now = new Date().toISOString();
    snapshot.achievements_progress = [...claimed, achievementId].slice(0, 1000);
    snapshot.progression_version = Math.max(4, Number(snapshot.progression_version || 0));
    snapshot.last_active_at = now;
    snapshot.synced_at = now;
    markVpsBackupPending(snapshot, now, {
      action: "secureClaimAchievement",
      achievement_id: achievementId,
    });

    return {
      snapshot,
      response: {
        ok: true,
        granted: true,
        already_claimed: false,
        local_reward: localReward,
        sensitive_reward: sensitiveReward,
      },
    };
  });
});

app.post("/v1/soul-chest/create", { preHandler: requireAstraAuth }, async (request, reply) => {
  const requestId = String(request.body?.request_id || "").trim().slice(0, 160);
  if (!requestId) {
    return reply.code(400).send({ ok: false, error: "Transaction invalide." });
  }

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const receiptRoot =
      snapshot._vps_receipts && typeof snapshot._vps_receipts === "object" && !Array.isArray(snapshot._vps_receipts)
        ? { ...snapshot._vps_receipts }
        : {};
    const receipts = Array.isArray(receiptRoot.soul_chest)
      ? receiptRoot.soul_chest.filter((entry) => entry && typeof entry === "object").slice(-99)
      : [];
    const duplicate = receipts.find((entry) => String(entry.request_id || "") === requestId);
    if (duplicate) {
      return {
        write: false,
        response: {
          ok: true,
          duplicate: true,
          cost_fragments: 20,
          chest_id: "rareChest",
        },
      };
    }

    const inventory = snapshotInventory(snapshot);
    if (Number(inventory.fragment || 0) < 20) {
      throw makeHttpError(409, "Il faut 20 fragments pour créer un coffre rare.");
    }

    inventory.fragment = Math.max(0, Number(inventory.fragment || 0) - 20);
    if (!inventory.fragment) delete inventory.fragment;
    inventory.rareChest = Math.min(
      MAX_RESOURCE,
      clampInt(inventory.rareChest, 0, MAX_RESOURCE) + 1,
    );

    const now = new Date().toISOString();
    receiptRoot.soul_chest = [
      ...receipts,
      { request_id: requestId, cost_fragments: 20, chest_id: "rareChest", created_at: now },
    ].slice(-100);

    snapshot.inventory = inventory;
    snapshot._vps_receipts = receiptRoot;
    snapshot.progression_version = Math.max(4, Number(snapshot.progression_version || 0));
    snapshot.last_active_at = now;
    snapshot.synced_at = now;
    markVpsBackupPending(snapshot, now, {
      action: "secureSoulChest",
      request_id: requestId,
    });

    return {
      snapshot,
      response: {
        ok: true,
        duplicate: false,
        cost_fragments: 20,
        chest_id: "rareChest",
      },
    };
  });
});

app.post("/v1/level-reward/claim", { preHandler: requireAstraAuth }, async (request, reply) => {
  const requestedLevel = Math.max(
    2,
    Math.min(100, Math.floor(Number(request.body?.requested_level || 0))),
  );

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const currentLevel = Math.max(1, Math.min(100, Math.floor(Number(snapshot.player_level || 1))));
    if (requestedLevel <= currentLevel) {
      return {
        write: false,
        response: { ok: true, granted: false },
      };
    }
    if (requestedLevel !== currentLevel + 1) {
      throw makeHttpError(409, "Progression de niveau invalide.");
    }

    const campaignBattles = Object.keys(snapshot.campaign_progress?.settlements || {}).length;
    const dungeonBattles = Object.keys(snapshot.dungeon_progress?.settlements || {}).length;
    const validatedBattleCount =
      Math.max(0, Number(snapshot.raids_won || 0)) +
      Math.max(0, Number(snapshot.raids_lost || 0)) +
      campaignBattles +
      dungeonBattles;

    const rewardMeta =
      snapshot._vps_level_reward &&
      typeof snapshot._vps_level_reward === "object" &&
      !Array.isArray(snapshot._vps_level_reward)
        ? { ...snapshot._vps_level_reward }
        : {};
    const lastRewardedLevel = Math.max(
      1,
      Math.floor(Number(rewardMeta.rewarded_to ?? currentLevel)),
    );
    const lastBattleCount = Math.max(
      0,
      Math.floor(Number(rewardMeta.battle_count ?? Math.max(0, validatedBattleCount - 1))),
    );

    if (requestedLevel <= lastRewardedLevel || validatedBattleCount <= lastBattleCount) {
      return {
        write: false,
        response: { ok: true, granted: false },
      };
    }

    addSnapshotGems(snapshot, 10);
    snapshot.player_level = requestedLevel;
    if (snapshot.player && typeof snapshot.player === "object" && !Array.isArray(snapshot.player)) {
      snapshot.player = { ...snapshot.player, level: requestedLevel };
    }
    snapshot._vps_level_reward = {
      rewarded_to: requestedLevel,
      battle_count: validatedBattleCount,
    };

    const now = new Date().toISOString();
    snapshot.progression_version = Math.max(4, Number(snapshot.progression_version || 0));
    snapshot.last_active_at = now;
    snapshot.synced_at = now;
    markVpsBackupPending(snapshot, now, {
      action: "secureLevelUpReward",
      requested_level: requestedLevel,
    });

    return {
      snapshot,
      response: {
        ok: true,
        granted: true,
        gems_awarded: 10,
      },
    };
  });
});

app.post("/v1/quests/claim-legacy", { preHandler: requireAstraAuth }, async (request, reply) => {
  const questId = String(request.body?.quest_id || "").trim().slice(0, 120);
  const quest = VPS_LEGACY_QUESTS[questId];
  if (!quest) {
    return reply.code(404).send({ ok: false, error: "Quête non migrée sur le VPS." });
  }

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const daily = normalizeDailyProgress(snapshot.daily_progress);
    const claimedQuests = Array.isArray(snapshot.claimed_quests)
      ? [...new Set(snapshot.claimed_quests.map((value) => String(value || "")).filter(Boolean))].slice(0, 1000)
      : [];
    const claimedList = quest.daily ? daily.claimed : claimedQuests;
    const alreadyClaimed = claimedList.includes(questId);
    const progressSource =
      quest.daily
        ? daily
        : snapshot.stats_progress && typeof snapshot.stats_progress === "object" && !Array.isArray(snapshot.stats_progress)
          ? snapshot.stats_progress
          : {};
    const localReward = {};
    const sensitiveReward = {};

    for (const [key, raw] of Object.entries(quest.reward || {})) {
      const amount = Math.max(0, Math.floor(Number(raw || 0)));
      if (!amount) continue;
      if (key === "gems" || ["chest", "rareChest", "epicChest", "legendChest", "starterRareChest"].includes(key)) {
        sensitiveReward[key] = amount;
      } else {
        localReward[key] = amount;
      }
    }

    if (alreadyClaimed) {
      return {
        write: false,
        response: {
          ok: true,
          granted: false,
          already_claimed: true,
          local_reward: localReward,
        },
      };
    }

    if (Number(progressSource[quest.stat] || 0) < Number(quest.goal || 1)) {
      throw makeHttpError(409, "Objectif de quête non atteint.");
    }

    if (quest.daily) {
      daily.claimed = [...new Set([...daily.claimed, questId])].slice(0, 1000);
      snapshot.daily_progress = daily;
    } else {
      snapshot.claimed_quests = [...new Set([...claimedQuests, questId])].slice(0, 1000);
    }

    if (sensitiveReward.gems) {
      addSnapshotGems(snapshot, sensitiveReward.gems);
    }

    const chestIds = ["chest", "rareChest", "epicChest", "legendChest", "starterRareChest"];
    if (chestIds.some((key) => sensitiveReward[key])) {
      const inventory = snapshotInventory(snapshot);
      for (const key of chestIds) {
        const amount = Math.max(0, Math.floor(Number(sensitiveReward[key] || 0)));
        if (!amount) continue;
        inventory[key] = Math.min(
          MAX_RESOURCE,
          clampInt(inventory[key], 0, MAX_RESOURCE) + amount,
        );
      }
      snapshot.inventory = inventory;
    }

    const now = new Date().toISOString();
    snapshot.progression_version = Math.max(4, Number(snapshot.progression_version || 0));
    snapshot.last_active_at = now;
    snapshot.synced_at = now;
    markVpsBackupPending(snapshot, now, {
      action: "secureClaimQuest",
      quest_id: questId,
    });

    return {
      snapshot,
      response: {
        ok: true,
        granted: true,
        already_claimed: false,
        local_reward: localReward,
        sensitive_reward: sensitiveReward,
      },
    };
  });
});

app.post("/v1/buildings/speedup", { preHandler: requireAstraAuth }, async (request, reply) => {
  const requestId = String(request.body?.request_id || "").trim().slice(0, 160);
  const buildingId = String(request.body?.building_id || "").trim().slice(0, 120);
  if (!requestId || !buildingId) {
    return reply.code(400).send({ ok: false, error: "Accélération invalide." });
  }

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const receiptRoot =
      snapshot._vps_receipts && typeof snapshot._vps_receipts === "object" && !Array.isArray(snapshot._vps_receipts)
        ? { ...snapshot._vps_receipts }
        : {};
    const receipts = Array.isArray(receiptRoot.speedup)
      ? receiptRoot.speedup.filter((entry) => entry && typeof entry === "object").slice(-99)
      : [];
    const duplicate = receipts.find((entry) => String(entry.request_id || "") === requestId);
    if (duplicate) {
      return {
        write: false,
        response: {
          ok: true,
          duplicate: true,
          cost: Math.max(0, Number(duplicate.cost || 0)),
        },
      };
    }

    const buildings = Array.isArray(snapshot.buildings) ? snapshot.buildings : [];
    const building = buildings.find((entry) => String(entry?.id || "") === buildingId);
    if (!building) {
      throw makeHttpError(404, "Bâtiment introuvable.");
    }

    const end = Math.max(Number(building.upgradeEnd || 0), Number(building.buildEnd || 0));
    if (!end || end <= Date.now()) {
      throw makeHttpError(409, "Ce chantier est déjà terminé.");
    }

    const resources = ensureSnapshotResources(snapshot);
    const expectedRaw = request.body?.expected_gems_revision;
    if (expectedRaw !== undefined && expectedRaw !== null && expectedRaw !== "") {
      const expected = Math.max(0, Math.floor(Number(expectedRaw || 0)));
      if (expected !== Number(resources.gems_revision || 0)) {
        const error = makeHttpError(409, "Le solde de gemmes a changé. Rechargez le village.");
        error.stale_gems = true;
        throw error;
      }
    }

    const cost = Math.max(1, Math.ceil((end - Date.now()) / 10000));
    if (Number(resources.gems || 0) < cost) {
      throw makeHttpError(409, "Gemmes insuffisantes.");
    }

    const beforeRevision = Number(resources.gems_revision || 0);
    resources.gems = Math.max(0, Number(resources.gems || 0) - cost);
    resources.gems_revision = Math.min(MAX_RESOURCE, beforeRevision + 1);
    snapshot.resources = resources;

    const now = new Date().toISOString();
    receiptRoot.speedup = [
      ...receipts,
      { request_id: requestId, building_id: buildingId, cost, created_at: now },
    ].slice(-100);
    snapshot._vps_receipts = receiptRoot;
    snapshot.progression_version = Math.max(4, Number(snapshot.progression_version || 0));
    snapshot.last_active_at = now;
    snapshot.synced_at = now;
    markVpsBackupPending(snapshot, now, {
      action: "secureBuildingSpeedup",
      building_id: buildingId,
      request_id: requestId,
      expected_gems_revision: beforeRevision,
      pilot_vps_backup: true,
      pilot_locked_cost: cost,
    });

    return {
      snapshot,
      response: {
        ok: true,
        duplicate: false,
        cost,
      },
    };
  });
});

app.post("/v1/buildings/rebuild", { preHandler: requireAstraAuth }, async (request, reply) => {
  const wanted = new Set(
    (Array.isArray(request.body?.ids) ? request.body.ids : [])
      .slice(0, 400)
      .map((value) => String(value || "")),
  );

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const buildings = Array.isArray(snapshot.buildings)
      ? JSON.parse(JSON.stringify(snapshot.buildings))
      : [];
    const selected = buildings.filter((building) => building?.ruined === true && wanted.has(String(building?.id || "")));
    const selectedIds = selected.map((building) => String(building.id));

    if (!selectedIds.length) {
      return {
        write: false,
        response: {
          ok: true,
          repaired: 0,
          cost: 0,
        },
      };
    }

    const cost = selectedIds.length * 100;
    const resources =
      snapshot.resources && typeof snapshot.resources === "object" && !Array.isArray(snapshot.resources)
        ? { ...snapshot.resources }
        : {};
    const gold = Math.max(0, Math.floor(Number(resources.gold || 0)));
    const mana = Math.max(0, Math.floor(Number(resources.mana || 0)));
    const manaCost = Math.min(mana, cost);
    const goldCost = cost - manaCost;

    if (gold < goldCost) {
      throw makeHttpError(
        409,
        `Il faut ${cost.toLocaleString("fr-FR")} mana (ou pièces en complément) pour reconstruire ces bâtiments.`,
      );
    }

    const siege =
      snapshot.siege && typeof snapshot.siege === "object" && !Array.isArray(snapshot.siege)
        ? { ...snapshot.siege }
        : {};
    const nextSiege = {
      revision: Math.max(0, Math.floor(Number(siege.revision || 0))) + 1,
      goldDebits: Math.max(0, Number(siege.goldDebits || 0)) + goldCost,
      manaDebits: Math.max(0, Number(siege.manaDebits || 0)) + manaCost,
    };
    const selectedSet = new Set(selectedIds);
    const hpMap = {};

    snapshot.buildings = buildings.map((building) => {
      if (!selectedSet.has(String(building?.id || ""))) return building;
      const hp = Math.max(
        1,
        Math.floor(Number(building?.restoredHp || building?.hp || 1)),
      );
      hpMap[String(building.id)] = hp;
      return {
        ...building,
        hp,
        ruined: false,
        ruinVersion: nextSiege.revision,
        destroyedAt: 0,
        restoredHp: hp,
      };
    });

    snapshot.resources = {
      ...resources,
      gold: gold - goldCost,
      mana: mana - manaCost,
    };
    snapshot.siege = nextSiege;

    const now = new Date().toISOString();
    snapshot.synced_at = now;
    markVpsBackupPending(snapshot, now, {
      action: "rebuildBuildings",
      ids: selectedIds,
      pilot_vps_backup: true,
      pilot_rebuild_hp: hpMap,
    });

    return {
      snapshot,
      response: {
        ok: true,
        repaired: selectedIds.length,
        cost,
        manaCost,
        goldCost,
        rebuild_hp: hpMap,
      },
    };
  });
});

app.post("/v1/guardians/evolve", { preHandler: requireAstraAuth }, async (request, reply) => {
  const requestId = String(request.body?.request_id || "").trim().slice(0, 160);
  const mainId = String(request.body?.main_id || "").trim().slice(0, 120);
  const materialIds = [...new Set(
    (Array.isArray(request.body?.material_ids) ? request.body.material_ids : [])
      .map((value) => String(value || "").trim().slice(0, 120))
      .filter(Boolean),
  )];
  const requestedTargetStars = Math.floor(Number(request.body?.target_stars || 0));

  if (!requestId || !validSlug(mainId)) {
    return reply.code(400).send({
      ok: false,
      error: "Demande d’évolution invalide.",
    });
  }

  const { config: adminConfig } = await loadVpsAdminConfig();
  const evolution = {
    ...DEFAULT_GUARDIAN_EVOLUTION_VPS,
    ...(adminConfig?.guardianEvolution &&
    typeof adminConfig.guardianEvolution === "object" &&
    !Array.isArray(adminConfig.guardianEvolution)
      ? adminConfig.guardianEvolution
      : {}),
  };

  if (evolution.enabled === false) {
    return reply.code(409).send({
      ok: false,
      error: "Les évolutions sont temporairement désactivées.",
    });
  }

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const receiptRoot =
      snapshot._vps_receipts &&
      typeof snapshot._vps_receipts === "object" &&
      !Array.isArray(snapshot._vps_receipts)
        ? { ...snapshot._vps_receipts }
        : {};

    const receipts = Array.isArray(receiptRoot.guardian_evolution)
      ? receiptRoot.guardian_evolution
          .filter((entry) => entry && typeof entry === "object")
          .slice(-49)
      : [];

    const duplicate = receipts.find(
      (entry) => String(entry.request_id || "") === requestId,
    );

    if (duplicate) {
      return {
        write: false,
        response: {
          ok: true,
          idempotent: true,
          targetStars: Number(duplicate.target_stars || requestedTargetStars),
        },
      };
    }

    const heroes = Array.isArray(snapshot.heroes)
      ? JSON.parse(JSON.stringify(snapshot.heroes))
      : [];

    const main = heroes.find(
      (hero) =>
        String(hero?.id || "") === mainId &&
        hero?.unlocked === true &&
        Number(hero?.copies || 0) > 0,
    );

    if (!main) {
      throw makeHttpError(404, "Gardien principal introuvable.");
    }

    const monsterSettings =
      adminConfig?.monsters?.[main.type] &&
      typeof adminConfig.monsters[main.type] === "object"
        ? adminConfig.monsters[main.type]
        : {};

    if (monsterSettings?.evolutionEnabled === false) {
      throw makeHttpError(
        409,
        "L’évolution est désactivée pour ce gardien.",
      );
    }

    const currentStars = clampInt(main.evolutionStars, 0, 3);
    if (currentStars >= 3) {
      throw makeHttpError(
        409,
        "Ce gardien a déjà atteint l’évolution maximale.",
      );
    }

    const targetStars = currentStars + 1;
    if (requestedTargetStars !== targetStars) {
      throw makeHttpError(
        409,
        "Palier d’évolution incohérent.",
      );
    }

    const requiredLevel = clampInt(
      evolution[`maxLevel${currentStars}`] ??
        DEFAULT_GUARDIAN_EVOLUTION_VPS[`maxLevel${currentStars}`],
      1,
      200,
    );

    const newMaxLevel = clampInt(
      evolution[`maxLevel${targetStars}`] ??
        DEFAULT_GUARDIAN_EVOLUTION_VPS[`maxLevel${targetStars}`],
      requiredLevel,
      200,
    );

    const requiredCopies = Math.max(
      2,
      clampInt(
        evolution[`requiredCopies${targetStars}`] ??
          DEFAULT_GUARDIAN_EVOLUTION_VPS[`requiredCopies${targetStars}`],
        2,
        50,
      ),
    );

    const materialCount = requiredCopies - 1;

    const essenceCost = clampInt(
      evolution[`essenceCost${targetStars}`] ??
        DEFAULT_GUARDIAN_EVOLUTION_VPS[`essenceCost${targetStars}`],
      0,
      MAX_RESOURCE,
    );

    const manaCost = clampInt(
      evolution[`manaCost${targetStars}`] ??
        DEFAULT_GUARDIAN_EVOLUTION_VPS[`manaCost${targetStars}`],
      0,
      MAX_RESOURCE,
    );

    if (Number(main.level || 1) !== requiredLevel) {
      throw makeHttpError(
        409,
        `Le gardien principal doit être exactement niveau ${requiredLevel}.`,
      );
    }

    if (materialIds.length !== materialCount) {
      throw makeHttpError(
        409,
        `Il faut sélectionner exactement ${materialCount} gardien(s) matériau(x).`,
      );
    }

    if (materialIds.includes(mainId)) {
      throw makeHttpError(
        409,
        "Le gardien principal ne peut pas être consommé.",
      );
    }

    const defenderIds = new Set(
      (Array.isArray(snapshot.defenders) ? snapshot.defenders : [])
        .map((defender) => String(defender?.id || ""))
        .filter(Boolean),
    );

    const materials = [];
    for (const id of materialIds) {
      if (!validSlug(id)) {
        throw makeHttpError(400, "Identifiant de matériau invalide.");
      }

      const hero = heroes.find(
        (entry) => String(entry?.id || "") === id,
      );

      if (
        !hero ||
        hero.unlocked !== true ||
        Number(hero.copies || 0) <= 0
      ) {
        throw makeHttpError(
          409,
          "Un gardien matériau n’est plus disponible.",
        );
      }

      if (hero.type !== main.type) {
        throw makeHttpError(
          409,
          "Tous les matériaux doivent être exactement le même gardien.",
        );
      }

      if (Number(hero.evolutionStars || 0) !== currentStars) {
        throw makeHttpError(
          409,
          `Tous les matériaux doivent avoir ${currentStars} étoile(s).`,
        );
      }

      if (Number(hero.level || 1) !== requiredLevel) {
        throw makeHttpError(
          409,
          `Tous les matériaux doivent être exactement niveau ${requiredLevel}.`,
        );
      }

      if (hero.locked === true) {
        throw makeHttpError(
          409,
          "Un gardien verrouillé ne peut pas être utilisé comme matériau.",
        );
      }

      if (defenderIds.has(String(hero.id))) {
        throw makeHttpError(
          409,
          "Retirez d’abord le gardien de l’équipe ou de la défense.",
        );
      }

      materials.push(hero);
    }

    const resources =
      snapshot.resources &&
      typeof snapshot.resources === "object" &&
      !Array.isArray(snapshot.resources)
        ? { ...snapshot.resources }
        : {};

    const essenceInitialized =
      resources.evolution_essence_initialized === true;
    const essenceBalance = clampInt(
      resources.evolution_essence,
      0,
      MAX_RESOURCE,
    );
    const essenceRevision = clampInt(
      resources.evolution_essence_revision,
      0,
      MAX_RESOURCE,
    );
    const manaBalance = clampInt(
      resources.mana,
      0,
      MAX_RESOURCE,
    );

    if (!essenceInitialized) {
      throw makeHttpError(
        409,
        "Synchronisez d’abord votre Essence d’Évolution.",
      );
    }

    if (essenceBalance < essenceCost) {
      throw makeHttpError(
        409,
        `Il manque ${essenceCost - essenceBalance} Essence d’Évolution.`,
      );
    }

    if (manaBalance < manaCost) {
      throw makeHttpError(
        409,
        `Il manque ${manaCost - manaBalance} mana.`,
      );
    }

    const inventory = snapshotInventory(snapshot);

    for (const material of materials) {
      for (const item of Object.values(material.equipment || {})) {
        const itemId = String(item || "");
        if (!validSlug(itemId)) continue;
        inventory[itemId] = Math.min(
          MAX_RESOURCE,
          clampInt(inventory[itemId], 0, MAX_RESOURCE) + 1,
        );
      }
    }

    const materialSet = new Set(materialIds);

    snapshot.heroes = heroes.map((hero) => {
      if (String(hero?.id || "") === mainId) {
        return {
          ...hero,
          evolutionStars: targetStars,
          evolution_revision: Math.min(
            MAX_RESOURCE,
            clampInt(hero.evolution_revision, 0, MAX_RESOURCE) + 1,
          ),
          progress_revision: Math.min(
            MAX_RESOURCE,
            clampInt(hero.progress_revision, 0, MAX_RESOURCE) + 1,
          ),
        };
      }

      if (!materialSet.has(String(hero?.id || ""))) {
        return hero;
      }

      return {
        ...hero,
        unlocked: false,
        copies: 0,
        copies_revision: Math.min(
          MAX_RESOURCE,
          clampInt(hero.copies_revision, 0, MAX_RESOURCE) + 1,
        ),
        level: 1,
        xp: 0,
        progress_revision: Math.min(
          MAX_RESOURCE,
          clampInt(hero.progress_revision, 0, MAX_RESOURCE) + 1,
        ),
        equipment: {},
        equipment_revision: Math.min(
          MAX_RESOURCE,
          clampInt(hero.equipment_revision, 0, MAX_RESOURCE) + 1,
        ),
        evolutionStars: 0,
        evolution_revision: Math.min(
          MAX_RESOURCE,
          clampInt(hero.evolution_revision, 0, MAX_RESOURCE) + 1,
        ),
        locked: false,
        lock_revision: Math.min(
          MAX_RESOURCE,
          clampInt(hero.lock_revision, 0, MAX_RESOURCE) + 1,
        ),
      };
    });

    snapshot.inventory = inventory;
    snapshot.resources = {
      ...resources,
      mana: manaBalance - manaCost,
      evolution_essence_initialized: true,
      evolution_essence: essenceBalance - essenceCost,
      evolution_essence_revision: Math.min(
        MAX_RESOURCE,
        essenceRevision + 1,
      ),
    };

    const now = new Date().toISOString();

    const pilotEvolution = {
      requiredLevel,
      newMaxLevel,
      requiredCopies,
      essenceCost,
      manaCost,
    };

    receiptRoot.guardian_evolution = [
      ...receipts,
      {
        request_id: requestId,
        main_id: mainId,
        target_stars: targetStars,
        at: now,
      },
    ].slice(-50);

    snapshot._vps_receipts = receiptRoot;
    snapshot.progression_version = Math.max(
      4,
      Number(snapshot.progression_version || 0),
    );
    snapshot.last_active_at = now;
    snapshot.synced_at = now;

    markVpsBackupPending(snapshot, now, {
      action: "evolveGuardian",
      mainId,
      materialIds,
      targetStars,
      requestId,
      pilot_vps_backup: true,
      pilot_vps_evolution: pilotEvolution,
    });

    return {
      snapshot,
      response: {
        ok: true,
        targetStars,
        level: Number(main.level || 1),
        newMaxLevel,
        consumed: materialIds.length,
        essenceCost,
        manaCost,
        pilot_vps_evolution: pilotEvolution,
      },
    };
  });
});

app.post("/v1/quests/history", { preHandler: requireAstraAuth }, async (request, reply) => {
  const questId = String(request.body?.quest_id || "").trim().slice(0, 120);
  const questName = String(request.body?.quest_name || "").trim().slice(0, 160);
  const questType = String(request.body?.quest_type || "").trim().slice(0, 40);
  const objective = String(request.body?.objective || "").trim().slice(0, 80);
  const recordType = request.body?.record_type === "boss" ? "boss" : "quest";
  const outcome = request.body?.outcome === "lost" ? "lost" : "won";
  const periodKey = String(request.body?.period_key || "").trim().slice(0, 140);
  const clientEventKey = String(request.body?.event_key || "").trim().slice(0, 220);

  if (!questId || !questName || !clientEventKey) {
    return reply.code(400).send({
      ok: false,
      error: "Historique de quête incomplet.",
    });
  }

  const eventKey = `${request.astraUser.email}|${clientEventKey}`.slice(0, 360);
  const values = [
    eventKey,
    request.astraUser.email,
    String(request.astraUser.name || "").slice(0, 160),
    questId,
    questName,
    questType,
    objective,
    recordType,
    outcome,
    periodKey,
    clampInt(request.body?.run_index || 1, 1, 1000),
    clampInt(request.body?.attempt_index || 0, 0, 1000),
    clampInt(request.body?.max_attempts || 0, 0, 1000),
    String(request.body?.boss_type || "").trim().slice(0, 80),
    String(request.body?.boss_name || "").trim().slice(0, 120),
  ];

  const inserted = await pool.query(
    `INSERT INTO astra_quest_history (
       event_key, user_email, user_name, quest_id, quest_name,
       quest_type, objective, record_type, outcome, period_key,
       run_index, attempt_index, max_attempts, boss_type, boss_name,
       occurred_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW()
     )
     ON CONFLICT (event_key) DO NOTHING
     RETURNING *`,
    values,
  );

  const duplicate = inserted.rowCount === 0;
  const row = duplicate
    ? (
        await pool.query(
          `SELECT * FROM astra_quest_history WHERE event_key = $1 LIMIT 1`,
          [eventKey],
        )
      ).rows[0]
    : inserted.rows[0];

  return {
    ok: true,
    duplicate,
    entry: row || null,
    source: "vps",
  };
});

app.get("/v1/admin/quests/history/status", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const result = await pool.query(
    `SELECT value
       FROM astra_settings
      WHERE setting_key = 'astra_quest_history_migration'
      LIMIT 1`,
  );

  return {
    ok: true,
    imported: result.rowCount > 0,
    migration: result.rows?.[0]?.value || null,
  };
});

app.post("/v1/admin/quests/history/import", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const entries = (Array.isArray(request.body?.entries) ? request.body.entries : [])
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 500);

  const client = await pool.connect();
  let imported = 0;

  try {
    await client.query("BEGIN");

    for (const entry of entries) {
      const eventKey = String(entry.event_key || "").trim().slice(0, 360);
      const questId = String(entry.quest_id || "").trim().slice(0, 120);
      const questName = String(entry.quest_name || "").trim().slice(0, 160);

      if (!eventKey || !questId || !questName) continue;

      const occurredAt = Number.isFinite(Date.parse(String(entry.occurred_at || "")))
        ? String(entry.occurred_at)
        : new Date().toISOString();

      const result = await client.query(
        `INSERT INTO astra_quest_history (
           event_key, user_email, user_name, quest_id, quest_name,
           quest_type, objective, record_type, outcome, period_key,
           run_index, attempt_index, max_attempts, boss_type, boss_name,
           occurred_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
         )
         ON CONFLICT (event_key) DO NOTHING`,
        [
          eventKey,
          String(entry.user_email || "").trim().toLowerCase().slice(0, 254),
          String(entry.user_name || "").slice(0, 160),
          questId,
          questName,
          String(entry.quest_type || "").slice(0, 40),
          String(entry.objective || "").slice(0, 80),
          entry.record_type === "boss" ? "boss" : "quest",
          entry.outcome === "lost" ? "lost" : "won",
          String(entry.period_key || "").slice(0, 140),
          clampInt(entry.run_index || 1, 1, 1000),
          clampInt(entry.attempt_index || 0, 0, 1000),
          clampInt(entry.max_attempts || 0, 0, 1000),
          String(entry.boss_type || "").slice(0, 80),
          String(entry.boss_name || "").slice(0, 120),
          occurredAt,
        ],
      );

      imported += Number(result.rowCount || 0);
    }

    const migrationValue = {
      completed_at: new Date().toISOString(),
      imported,
      received: entries.length,
    };

    await client.query(
      `INSERT INTO astra_settings (setting_key, revision, value, updated_at)
       VALUES ('astra_quest_history_migration', 1, $1::jsonb, NOW())
       ON CONFLICT (setting_key)
       DO UPDATE SET
         revision = astra_settings.revision + 1,
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [JSON.stringify(migrationValue)],
    );

    await client.query("COMMIT");

    return {
      ok: true,
      imported,
      received: entries.length,
      migration: migrationValue,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/admin/quests/history/query", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const questId = String(request.body?.quest_id || "").trim().slice(0, 120);
  const recordType = ["quest", "boss"].includes(String(request.body?.record_type || ""))
    ? String(request.body.record_type)
    : "";
  const outcome = ["won", "lost"].includes(String(request.body?.outcome || ""))
    ? String(request.body.outcome)
    : "";
  const limit = clampInt(request.body?.limit || 300, 1, 500);

  const where = [];
  const values = [];

  if (questId) {
    values.push(questId);
    where.push(`quest_id = $${values.length}`);
  }

  if (recordType) {
    values.push(recordType);
    where.push(`record_type = $${values.length}`);
  }

  if (outcome) {
    values.push(outcome);
    where.push(`outcome = $${values.length}`);
  }

  values.push(limit);

  const rows = await pool.query(
    `SELECT
       id, event_key, user_email, user_name, quest_id, quest_name,
       quest_type, objective, record_type, outcome, period_key,
       run_index, attempt_index, max_attempts, boss_type, boss_name,
       occurred_at
     FROM astra_quest_history
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY occurred_at DESC
     LIMIT $${values.length}`,
    values,
  );

  return {
    ok: true,
    entries: rows.rows || [],
    source: "vps",
  };
});

app.get("/v1/admin/global-backups/pending", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const result = await pool.query(
    `SELECT id, action, created_at
       FROM astra_global_backup_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 100`,
  );

  return {
    ok: true,
    entries: result.rows || [],
  };
});

app.post("/v1/admin/global-backups/ack", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const id = String(request.body?.id || "").trim().slice(0, 120);
  if (!id) {
    return reply.code(400).send({
      ok: false,
      error: "Sauvegarde globale invalide.",
    });
  }

  await pool.query(
    `UPDATE astra_global_backup_queue
        SET status = 'done',
            resolved_at = NOW()
      WHERE id = $1`,
    [id],
  );

  return { ok: true, id };
});

app.post("/v1/admin/global-gifts/publish", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const rawGems = Number(request.body?.gems);
  const gems = clampInt(rawGems, 1, MAX_GEMS);
  if (!Number.isFinite(rawGems) || rawGems < 1 || rawGems > MAX_GEMS) {
    return reply.code(400).send({
      ok: false,
      error: "Le nombre de gemmes doit être compris entre 1 et 1 000 000.",
    });
  }

  const publishedAt = new Date().toISOString();
  const gift = normalizeGlobalGiftVps({
    id: `gift_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`,
    gems,
    published_at: publishedAt,
    title: "Cadeau !",
    subtitle: `${gems.toLocaleString("fr-FR")} gemmes offertes !`,
    message:
      "Cadeau de l’équipe Astral : merci de faire partie de l’aventure. Ces gemmes vous sont offertes pour poursuivre vos aventures et seront ajoutées à votre compte après validation.",
    button_label: "Réclamer",
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO astra_global_gifts (id, gift, published_at, synced_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (id)
       DO UPDATE SET
         gift = EXCLUDED.gift,
         published_at = EXCLUDED.published_at,
         synced_at = NOW()`,
      [gift.id, JSON.stringify(gift), gift.published_at],
    );

    const backupId = await queueGlobalBackup(client, {
      action: "publishGlobalGift",
      gems,
      pilot_vps_backup: true,
      pilot_vps_gift: gift,
    });

    await client.query("COMMIT");

    return {
      ok: true,
      gift,
      backup_id: backupId,
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/admin/merchant/sync", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const merchantImage = normalizeMerchantImageVps(request.body?.merchant_image);
  const offer = normalizeMerchantOfferVps(request.body?.offer);
  const value = {
    version: 2,
    merchant_image: merchantImage,
    offer: offer
      ? { ...offer, merchant_image: merchantImage }
      : null,
  };

  await pool.query(
    `INSERT INTO astra_settings (setting_key, revision, value, updated_at)
     VALUES ('astra_guardian_merchant', 1, $1::jsonb, NOW())
     ON CONFLICT (setting_key)
     DO UPDATE SET
       revision = astra_settings.revision + 1,
       value = EXCLUDED.value,
       updated_at = NOW()`,
    [JSON.stringify(value)],
  );

  return {
    ok: true,
    merchant_image: merchantImage,
    offer: value.offer,
    source: "vps",
  };
});

app.put("/v1/admin/merchant/image", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const merchantImage = normalizeMerchantImageVps(request.body?.merchant_image);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT value
         FROM astra_settings
        WHERE setting_key = 'astra_guardian_merchant'
        LIMIT 1`,
    );

    const existing =
      current.rows?.[0]?.value &&
      typeof current.rows[0].value === "object" &&
      !Array.isArray(current.rows[0].value)
        ? current.rows[0].value
        : {};

    const offer = normalizeMerchantOfferVps(existing.offer);
    const value = {
      version: 2,
      merchant_image: merchantImage,
      offer: offer
        ? { ...offer, merchant_image: merchantImage }
        : null,
    };

    await client.query(
      `INSERT INTO astra_settings (setting_key, revision, value, updated_at)
       VALUES ('astra_guardian_merchant', 1, $1::jsonb, NOW())
       ON CONFLICT (setting_key)
       DO UPDATE SET
         revision = astra_settings.revision + 1,
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [JSON.stringify(value)],
    );

    const backupId = await queueGlobalBackup(client, {
      action: "adminSetGuardianMerchantImage",
      merchant_image: merchantImage,
    });

    await client.query("COMMIT");

    return {
      ok: true,
      merchant_image: merchantImage,
      offer: value.offer,
      backup_id: backupId,
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/admin/merchant/publish", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const guardianType = String(request.body?.guardian_type || "").trim().slice(0, 64);
  if (!validSlug(guardianType)) {
    return reply.code(400).send({
      ok: false,
      error: "Gardien recherché invalide.",
    });
  }

  const { config: adminConfig } = await loadVpsAdminConfig();
  const knownGuardian =
    Boolean(adminConfig?.monsters?.[guardianType]) ||
    Object.prototype.hasOwnProperty.call(BASE_GUARDIAN_RARITY, guardianType);

  if (!knownGuardian) {
    return reply.code(400).send({
      ok: false,
      error: "Ce gardien n’existe pas dans le catalogue ASTRAL.",
    });
  }

  const levelMode = request.body?.level_mode === "range" ? "range" : "exact";
  const exactLevel = clampInt(request.body?.level_exact || 1, 1, 200);
  let levelMin = clampInt(request.body?.level_min || exactLevel, 1, 200);
  let levelMax = clampInt(request.body?.level_max || exactLevel, 1, 200);
  if (levelMin > levelMax) [levelMin, levelMax] = [levelMax, levelMin];

  const rewardGems = clampInt(request.body?.reward_gems, 1, MAX_GEMS);
  const activationMode = ["manual", "scheduled", "random"].includes(
    String(request.body?.activation_mode || ""),
  )
    ? String(request.body.activation_mode)
    : "manual";

  const publishedAt = new Date().toISOString();
  const offerId = `merchant_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
  let startsAt = publishedAt;
  let endsAt = "";

  if (activationMode === "scheduled") {
    const startMs = Date.parse(String(request.body?.starts_at || ""));
    const endText = String(request.body?.ends_at || "").trim();
    const endMs = endText ? Date.parse(endText) : NaN;

    if (!Number.isFinite(startMs)) {
      return reply.code(400).send({
        ok: false,
        error: "Indiquez une date et une heure de début valides.",
      });
    }
    if (endText && (!Number.isFinite(endMs) || endMs <= startMs)) {
      return reply.code(400).send({
        ok: false,
        error: "La fin programmée doit être postérieure au début.",
      });
    }

    startsAt = new Date(startMs).toISOString();
    endsAt = endText ? new Date(endMs).toISOString() : "";
  } else if (activationMode === "random") {
    let minMinutes = clampInt(request.body?.random_min_minutes ?? 30, 0, 10080);
    let maxMinutes = clampInt(request.body?.random_max_minutes ?? 180, 0, 10080);
    if (minMinutes > maxMinutes) [minMinutes, maxMinutes] = [maxMinutes, minMinutes];

    const durationMinutes = clampInt(
      request.body?.random_duration_minutes ?? 60,
      1,
      10080,
    );
    const delayMinutes = secureRandomIntVps(minMinutes, maxMinutes);
    const startMs = Date.now() + delayMinutes * 60_000;
    startsAt = new Date(startMs).toISOString();
    endsAt = new Date(startMs + durationMinutes * 60_000).toISOString();
  }

  const currentMerchantSetting = await pool.query(
    `SELECT value
       FROM astra_settings
      WHERE setting_key = 'astra_guardian_merchant'
      LIMIT 1`,
  );
  const currentMerchantValue =
    currentMerchantSetting.rows?.[0]?.value &&
    typeof currentMerchantSetting.rows[0].value === "object" &&
    !Array.isArray(currentMerchantSetting.rows[0].value)
      ? currentMerchantSetting.rows[0].value
      : {};
  const merchantImage =
    normalizeMerchantImageVps(request.body?.merchant_image) ||
    normalizeMerchantImageVps(currentMerchantValue.merchant_image);
  const guardianName =
    String(
      adminConfig?.monsters?.[guardianType]?.name ||
        request.body?.guardian_name ||
        guardianType,
    )
      .trim()
      .slice(0, 120) || guardianType;

  const offer = normalizeMerchantOfferVps({
    id: offerId,
    enabled: true,
    guardian_type: guardianType,
    guardian_name: guardianName,
    level_mode: levelMode,
    level_exact: exactLevel,
    level_min: levelMin,
    level_max: levelMax,
    reward_gems: rewardGems,
    activation_mode: activationMode,
    starts_at: startsAt,
    ends_at: endsAt,
    published_at: publishedAt,
  });

  const value = {
    version: 2,
    merchant_image: merchantImage,
    offer: { ...offer, merchant_image: merchantImage },
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO astra_settings (setting_key, revision, value, updated_at)
       VALUES ('astra_guardian_merchant', 1, $1::jsonb, NOW())
       ON CONFLICT (setting_key)
       DO UPDATE SET
         revision = astra_settings.revision + 1,
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [JSON.stringify(value)],
    );

    const backupId = await queueGlobalBackup(client, {
      action: "adminPublishGuardianMerchant",
      guardian_type: guardianType,
      guardian_name: guardianName,
      level_mode: levelMode,
      level_exact: exactLevel,
      level_min: levelMin,
      level_max: levelMax,
      reward_gems: rewardGems,
      activation_mode: activationMode,
      starts_at: startsAt,
      ends_at: endsAt,
      merchant_image: merchantImage,
      pilot_vps_backup: true,
      pilot_vps_offer: offer,
    });

    await client.query("COMMIT");

    return {
      ok: true,
      merchant_image: merchantImage,
      offer: value.offer,
      backup_id: backupId,
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/admin/merchant/disable", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT value
         FROM astra_settings
        WHERE setting_key = 'astra_guardian_merchant'
        LIMIT 1`,
    );

    const existing =
      current.rows?.[0]?.value &&
      typeof current.rows[0].value === "object" &&
      !Array.isArray(current.rows[0].value)
        ? current.rows[0].value
        : {};

    const merchantImage = normalizeMerchantImageVps(existing.merchant_image);
    const offer = normalizeMerchantOfferVps(existing.offer);
    const nextOffer = offer
      ? { ...offer, enabled: false, merchant_image: merchantImage }
      : null;
    const value = {
      version: 2,
      merchant_image: merchantImage,
      offer: nextOffer,
    };

    await client.query(
      `INSERT INTO astra_settings (setting_key, revision, value, updated_at)
       VALUES ('astra_guardian_merchant', 1, $1::jsonb, NOW())
       ON CONFLICT (setting_key)
       DO UPDATE SET
         revision = astra_settings.revision + 1,
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [JSON.stringify(value)],
    );

    const backupId = await queueGlobalBackup(client, {
      action: "adminDisableGuardianMerchant",
    });

    await client.query("COMMIT");

    return {
      ok: true,
      status: "disabled",
      merchant_image: merchantImage,
      offer: nextOffer,
      backup_id: backupId,
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/admin/global-gifts/sync", { preHandler: requireAstraAuth }, async (request, reply) => {
  if (!isAstraAdminUser(request.astraUser)) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const gifts = (Array.isArray(request.body?.gifts) ? request.body.gifts : [])
    .map(normalizeGlobalGiftVps)
    .filter(Boolean)
    .slice(0, 100);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const gift of gifts) {
      await client.query(
        `INSERT INTO astra_global_gifts (id, gift, published_at, synced_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (id)
         DO UPDATE SET
           gift = EXCLUDED.gift,
           published_at = EXCLUDED.published_at,
           synced_at = NOW()`,
        [gift.id, JSON.stringify(gift), gift.published_at],
      );
    }

    await client.query("COMMIT");

    return {
      ok: true,
      synced: gifts.length,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.post("/v1/global-gifts/claim", { preHandler: requireAstraAuth }, async (request, reply) => {
  const giftId = String(request.body?.gift_id || "").trim().slice(0, 120);

  if (!giftId) {
    return reply.code(400).send({
      ok: false,
      error: "Cadeau global invalide.",
    });
  }

  return mutateLockedVillage(request, reply, async (snapshot, revision, client) => {
    const giftResult = await client.query(
      `SELECT gift
         FROM astra_global_gifts
        WHERE id = $1
        LIMIT 1`,
      [giftId],
    );

    const gift = normalizeGlobalGiftVps(giftResult.rows?.[0]?.gift);

    if (!gift) {
      throw makeHttpError(
        404,
        "Ce cadeau n’est pas disponible sur le VPS.",
      );
    }

    const villageCreatedAt = Date.parse(
      String(snapshot?.created_at || ""),
    );
    const giftPublishedAt = Date.parse(
      String(gift.published_at || ""),
    );
    if (
      Number.isFinite(villageCreatedAt) &&
      Number.isFinite(giftPublishedAt) &&
      villageCreatedAt > giftPublishedAt
    ) {
      throw makeHttpError(
        404,
        "Ce cadeau n’est pas disponible pour ce compte.",
      );
    }

    const existingResult = await client.query(
      `SELECT award
         FROM astra_global_gift_claims
        WHERE gift_id = $1 AND user_email = $2
        LIMIT 1`,
      [giftId, request.astraUser.email],
    );

    const resources =
      snapshot.resources &&
      typeof snapshot.resources === "object" &&
      !Array.isArray(snapshot.resources)
        ? { ...snapshot.resources }
        : {};

    const gemsInitialized = resources.gems_initialized === true;
    const gemsBefore = clampInt(resources.gems, 0, MAX_GEMS);
    const gemsRevisionBefore = clampInt(
      resources.gems_revision,
      0,
      MAX_RESOURCE,
    );

    if (existingResult.rowCount) {
      return {
        write: false,
        response: {
          ok: true,
          granted: false,
          already_claimed: true,
          award: existingResult.rows[0].award,
          gems_server_applied: gemsInitialized,
          gems_balance: gemsInitialized ? gemsBefore : null,
          gems_revision: gemsInitialized ? gemsRevisionBefore : null,
        },
      };
    }

    const now = new Date().toISOString();
    const award = {
      id: gift.id,
      gems: gift.gems,
      published_at: gift.published_at,
      claimed_at: now,
    };

    let gemsBalance = null;
    let gemsRevision = null;

    if (gemsInitialized) {
      gemsBalance = Math.min(
        MAX_GEMS,
        gemsBefore + Math.max(0, Number(gift.gems || 0)),
      );
      gemsRevision = Math.min(
        MAX_RESOURCE,
        gemsRevisionBefore + 1,
      );
      resources.gems = gemsBalance;
      resources.gems_revision = gemsRevision;
      snapshot.resources = resources;
    }

    await client.query(
      `INSERT INTO astra_global_gift_claims (
         gift_id, user_email, award, claimed_at
       ) VALUES ($1, $2, $3::jsonb, $4)`,
      [
        gift.id,
        request.astraUser.email,
        JSON.stringify(award),
        now,
      ],
    );

    snapshot.last_active_at = now;
    snapshot.synced_at = now;

    markVpsBackupPending(snapshot, now, {
      action: "claimGlobalGift",
      gift_id: gift.id,
    });

    return {
      snapshot,
      response: {
        ok: true,
        granted: true,
        already_claimed: false,
        award,
        gems_server_applied: gemsInitialized,
        gems_balance: gemsBalance,
        gems_revision: gemsRevision,
      },
    };
  });
});

app.post("/v1/chests/open", { preHandler: requireAstraAuth }, async (request, reply) => {
  const requestId = String(request.body?.request_id || "").trim().slice(0, 160);
  const chestId = String(request.body?.chest_id || "").trim();

  if (!requestId || !SECURE_CHEST_IDS.has(chestId)) {
    return reply.code(400).send({
      ok: false,
      error: "Ouverture de coffre invalide.",
    });
  }

  const { config: adminConfig } = await loadVpsAdminConfig();
  const config = secureChestConfigVps(adminConfig, chestId);
  if (!config) {
    return reply.code(409).send({
      ok: false,
      error: "Configuration de coffre invalide.",
    });
  }

  const guardians = secureGuardianCatalogVps(adminConfig);

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const receiptRoot =
      snapshot._vps_receipts &&
      typeof snapshot._vps_receipts === "object" &&
      !Array.isArray(snapshot._vps_receipts)
        ? { ...snapshot._vps_receipts }
        : {};

    const receipts = Array.isArray(receiptRoot.chests)
      ? receiptRoot.chests
          .filter(
            (entry) =>
              entry &&
              typeof entry === "object",
          )
          .slice(-99)
      : [];

    const duplicateReceipt = receipts.find(
      (entry) =>
        String(entry.request_id || "") === requestId,
    );

    if (duplicateReceipt) {
      return {
        write: false,
        response: {
          ok: true,
          duplicate: true,
          result: duplicateReceipt.result || null,
        },
      };
    }

    const inventory = snapshotInventory(snapshot);
    if (Number(inventory[chestId] || 0) < 1) {
      throw makeHttpError(
        409,
        "Ce coffre n’est plus disponible.",
      );
    }

    const heroes = Array.isArray(snapshot.heroes)
      ? JSON.parse(JSON.stringify(snapshot.heroes))
      : [];
    const history = Array.isArray(snapshot.chest_history)
      ? JSON.parse(JSON.stringify(snapshot.chest_history)).slice(0, 100)
      : [];

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const result = {
      id: crypto.randomUUID(),
      chestId,
      date: nowMs,
      gold: secureRandomIntVps(
        config.goldMin,
        config.goldMax,
      ),
      mana: Math.max(
        0,
        Math.floor(Number(config.mana || 0)),
      ),
    };

    const starterType =
      chestId === "starterRareChest" &&
      guardians.imp &&
      guardians.imp.disabled !== true
        ? "imp"
        : "";

    const monsterRoll =
      Boolean(starterType) ||
      secureRandomUnitVps() * 100 <
        Math.max(
          0,
          Math.min(
            100,
            Number(config.monsterChance || 0),
          ),
        );

    if (monsterRoll) {
      const available = Object.values(guardians).filter(
        (guardian) =>
          guardian &&
          guardian.disabled !== true &&
          Number(guardian.dropWeight || 0) > 0,
      );

      const rarity = starterType
        ? String(
            guardians[starterType].rarity || "Commun",
          )
        : secureWeightedVps(
            Object.entries(config.rarities || {}).filter(
              ([rarityName, weight]) =>
                Number(weight || 0) > 0 &&
                available.some(
                  (guardian) =>
                    String(guardian.rarity) ===
                    String(rarityName),
                ),
            ),
          );

      const type = starterType || secureWeightedVps(
        available
          .filter(
            (guardian) =>
              String(guardian.rarity) ===
              String(rarity),
          )
          .map((guardian) => [
            String(guardian.id),
            Math.max(
              0,
              Number(guardian.dropWeight || 0),
            ),
          ]),
      );

      if (!type || !guardians[type]) {
        throw makeHttpError(
          409,
          "Aucun gardien valide dans la table de ce coffre.",
        );
      }

      const owned = heroes.filter(
        (hero) =>
          hero &&
          hero.type === type &&
          hero.unlocked === true &&
          Number(hero.copies || 0) > 0,
      );

      const duplicateXP = Math.max(
        0,
        Math.floor(
          Number(
            adminConfig?.economy?.duplicateXP ?? 300,
          ),
        ),
      );
      const duplicateCrystals = Math.max(
        0,
        Math.floor(
          Number(
            adminConfig?.economy?.duplicateCrystals ??
              20,
          ),
        ),
      );

      if (owned.length && duplicateXP > 0) {
        applyGuardianXpVps(
          owned[0],
          duplicateXP,
          adminConfig,
        );
        result.duplicateXP = duplicateXP;
        result.duplicateCrystals =
          duplicateCrystals;
        result.duplicatePrimaryHeroId = String(
          owned[0].id || "",
        ).slice(0, 120);
        result.duplicatePrimaryLevel = Math.max(
          1,
          Math.floor(Number(owned[0].level || 1)),
        );
        result.duplicatePrimaryXp = Math.max(
          0,
          Math.floor(Number(owned[0].xp || 0)),
        );
        result.duplicatePrimaryProgressRevision =
          Math.max(
            0,
            Math.floor(
              Number(
                owned[0].progress_revision || 0,
              ),
            ),
          );
      }

      const heroId = crypto.randomUUID();

      heroes.push({
        id: heroId,
        type,
        unlocked: true,
        level: 1,
        xp: 0,
        progress_revision: 0,
        copies: 1,
        copies_revision: 1,
        equipment: {},
        equipment_revision: 1,
        evolutionStars: 0,
        evolution_revision: 0,
        locked: false,
        lock_revision: 0,
        obtained_at: nowIso,
      });

      result.kind = "monster";
      result.type = type;
      result.heroId = heroId;
      result.heroObtainedAt = nowIso;
      result.rarity = String(
        guardians[type].rarity ||
          rarity ||
          "Commun",
      );
      result.isNew = owned.length === 0;
      result.copyCount = owned.length + 1;
      result.sacrificableCopies = Math.max(
        0,
        result.copyCount - 1,
      );

      if (starterType) {
        result.starterGuardian = true;
      }
    } else {
      const item = secureWeightedVps(
        Object.entries(config.equipment || {}),
      );

      if (!item || !validSlug(item)) {
        throw makeHttpError(
          409,
          "Aucun objet valide dans la table de ce coffre.",
        );
      }

      result.kind = "item";
      result.item = item;
      result.rarity = String(
        adminConfig?.items?.[item]?.rarity ||
          BASE_ITEM_RARITY[item] ||
          "Commun",
      );
      result.isNew = false;

      inventory[item] = Math.min(
        MAX_RESOURCE,
        clampInt(inventory[item], 0, MAX_RESOURCE) +
          1,
      );
    }

    inventory[chestId] = Math.max(
      0,
      Number(inventory[chestId] || 0) - 1,
    );
    if (!inventory[chestId]) {
      delete inventory[chestId];
    }

    const resources =
      snapshot.resources &&
      typeof snapshot.resources === "object" &&
      !Array.isArray(snapshot.resources)
        ? { ...snapshot.resources }
        : {};

    const goldBefore = clampInt(
      resources.gold,
      0,
      MAX_RESOURCE,
    );
    const manaBefore = clampInt(
      resources.mana,
      0,
      MAX_RESOURCE,
    );

    const goldCapacity = secureStorageCapacityVps(
      adminConfig,
      snapshot.buildings,
      "gold",
    );
    const manaCapacity = secureStorageCapacityVps(
      adminConfig,
      snapshot.buildings,
      "mana",
    );

    const gold = Math.min(
      Math.max(goldBefore, goldCapacity),
      goldBefore + Number(result.gold || 0),
    );
    const mana = Math.min(
      Math.max(manaBefore, manaCapacity),
      manaBefore + Number(result.mana || 0),
    );

    result.receivedGold = gold - goldBefore;
    result.receivedMana = mana - manaBefore;

    snapshot.inventory = inventory;
    snapshot.heroes = heroes;
    snapshot.chest_history = [
      result,
      ...history,
    ].slice(0, 100);
    snapshot.resources = {
      ...resources,
      gold,
      mana,
    };
    snapshot.progression_version = Math.max(
      4,
      Number(snapshot.progression_version || 0),
    );
    snapshot.last_active_at = nowIso;
    snapshot.synced_at = nowIso;

    receiptRoot.chests = [
      ...receipts,
      {
        request_id: requestId,
        result,
      },
    ].slice(-100);
    snapshot._vps_receipts = receiptRoot;

    markVpsBackupPending(snapshot, nowIso, {
      action: "secureOpenChest",
      chest_id: chestId,
      request_id: requestId,
      pilot_vps_backup: true,
      pilot_vps_result: result,
    });

    return {
      snapshot,
      response: {
        ok: true,
        duplicate: false,
        result,
      },
    };
  });
});

app.post("/v1/shop/purchase", { preHandler: requireAstraAuth }, async (request, reply) => {
  const requestId = String(request.body?.request_id || "").trim().slice(0, 160);
  const offerId = String(request.body?.offer_id || "").trim();
  const quantity = Math.max(
    1,
    Math.min(1000, Math.floor(Number(request.body?.quantity || 1))),
  );

  if (!requestId || !validSlug(offerId)) {
    return reply.code(400).send({ ok: false, error: "Achat invalide." });
  }

  const { config: adminConfig } = await loadVpsAdminConfig();
  const offer = secureShopOfferVps(adminConfig, offerId);
  if (!offer) {
    return reply.code(404).send({ ok: false, error: "Article indisponible." });
  }

  const costEntry = Object.entries(offer.cost || {})[0];
  if (!costEntry) {
    return reply.code(409).send({ ok: false, error: "Prix de boutique invalide." });
  }

  const currency = String(costEntry[0]);
  if (!["gems", "gold", "mana", "energy"].includes(currency)) {
    return reply.code(409).send({
      ok: false,
      error: "Cette monnaie n’est pas encore validée par le serveur.",
    });
  }

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const receiptRoot =
      snapshot._vps_receipts &&
      typeof snapshot._vps_receipts === "object" &&
      !Array.isArray(snapshot._vps_receipts)
        ? { ...snapshot._vps_receipts }
        : {};
    const receipts = Array.isArray(receiptRoot.shop)
      ? receiptRoot.shop.filter((entry) => entry && typeof entry === "object").slice(-99)
      : [];
    const duplicate = receipts.find(
      (entry) => String(entry.request_id || "") === requestId,
    );

    if (duplicate) {
      return {
        write: false,
        response: {
          ok: true,
          duplicate: true,
          purchase: duplicate.purchase || null,
        },
      };
    }

    let resources =
      snapshot.resources &&
      typeof snapshot.resources === "object" &&
      !Array.isArray(snapshot.resources)
        ? { ...snapshot.resources }
        : {};

    const beforeGemsRevision = clampInt(
      resources.gems_revision,
      0,
      MAX_RESOURCE,
    );

    if (
      currency === "gems" &&
      request.body?.expected_gems_revision !== undefined &&
      request.body?.expected_gems_revision !== null &&
      request.body?.expected_gems_revision !== ""
    ) {
      const expected = clampInt(
        request.body.expected_gems_revision,
        0,
        MAX_RESOURCE,
      );
      if (expected !== beforeGemsRevision) {
        throw makeHttpError(
          409,
          "Le solde de gemmes a changé. Rechargez la boutique.",
        );
      }
    }

    const discount = secureMarketDiscountVps(snapshot.buildings);
    const unitCost = Math.max(
      1,
      Math.ceil(Number(costEntry[1] || 0) * (1 - discount)),
    );
    const totalCost = Math.min(MAX_RESOURCE, unitCost * quantity);

    const reward = Object.fromEntries(
      Object.entries(offer.reward || {}).map(([key, value]) => [
        key,
        Math.min(
          MAX_RESOURCE,
          Math.max(0, Math.floor(Number(value || 0) * quantity)),
        ),
      ]),
    );

    if (Object.prototype.hasOwnProperty.call(reward, "crystals")) {
      throw makeHttpError(
        409,
        "Cet article doit être acheté depuis la boutique classique.",
      );
    }

    const inventory = snapshotInventory(snapshot);
    let gold = clampInt(resources.gold, 0, MAX_RESOURCE);
    let mana = clampInt(resources.mana, 0, MAX_RESOURCE);

    const goldCapacity = secureStorageCapacityVps(
      adminConfig,
      snapshot.buildings,
      "gold",
    );
    const manaCapacity = secureStorageCapacityVps(
      adminConfig,
      snapshot.buildings,
      "mana",
    );

    const energyState = materializeEnergyResources(resources);
    resources = energyState.resources;

    const balance =
      currency === "gems"
        ? clampInt(resources.gems, 0, MAX_GEMS)
        : currency === "gold"
          ? gold
          : currency === "mana"
            ? mana
            : energyState.initialized
              ? energyState.energy
              : ENERGY_CAPACITY;

    if (balance < totalCost) {
      throw makeHttpError(
        409,
        "Ressources insuffisantes pour cet achat.",
      );
    }

    snapshot.resources = resources;

    if (currency === "gems") {
      applySnapshotGemDelta(snapshot, -totalCost);
      resources = snapshot.resources;
    } else if (currency === "gold") {
      gold -= totalCost;
    } else if (currency === "mana") {
      mana -= totalCost;
    } else {
      resources.energy_initialized = true;
      resources.energy = Math.max(0, balance - totalCost);
      resources.energy_revision = Math.min(
        MAX_RESOURCE,
        clampInt(resources.energy_revision, 0, MAX_RESOURCE) + 1,
      );
      resources.energy_updated_at = Date.now();
    }

    for (const [key, amountRaw] of Object.entries(reward)) {
      const amount = Math.max(0, Math.floor(Number(amountRaw || 0)));
      if (!amount) continue;

      if (key === "gold") {
        gold = Math.min(
          Math.max(gold, goldCapacity),
          gold + amount,
        );
      } else if (key === "mana") {
        mana = Math.min(
          Math.max(mana, manaCapacity),
          mana + amount,
        );
      } else if (key === "gems") {
        snapshot.resources = resources;
        applySnapshotGemDelta(snapshot, amount);
        resources = snapshot.resources;
      } else if (key === "energy") {
        const beforeEnergy =
          resources.energy_initialized === true
            ? Math.max(0, Number(resources.energy || 0))
            : ENERGY_CAPACITY;
        resources.energy_initialized = true;
        resources.energy = Math.min(
          ENERGY_CAPACITY,
          beforeEnergy + amount,
        );
        resources.energy_revision = Math.min(
          MAX_RESOURCE,
          clampInt(resources.energy_revision, 0, MAX_RESOURCE) + 1,
        );
        resources.energy_updated_at = Date.now();
      } else if (validSlug(key)) {
        inventory[key] = Math.min(
          MAX_RESOURCE,
          clampInt(inventory[key], 0, MAX_RESOURCE) + amount,
        );
      }
    }

    resources.gold = gold;
    resources.mana = mana;
    snapshot.resources = resources;
    snapshot.inventory = inventory;

    const nowIso = new Date().toISOString();
    const purchase = {
      request_id: requestId,
      offer_id: offerId,
      quantity,
      cost: { [currency]: totalCost },
      reward,
      created_at: nowIso,
    };

    receiptRoot.shop = [
      ...receipts,
      { request_id: requestId, purchase },
    ].slice(-100);
    snapshot._vps_receipts = receiptRoot;
    snapshot.progression_version = Math.max(
      4,
      Number(snapshot.progression_version || 0),
    );
    snapshot.last_active_at = nowIso;
    snapshot.synced_at = nowIso;

    markVpsBackupPending(snapshot, nowIso, {
      action: "secureShopPurchase",
      offer_id: offerId,
      quantity,
      request_id: requestId,
      expected_gems_revision: beforeGemsRevision,
      pilot_vps_backup: true,
      pilot_purchase: purchase,
    });

    return {
      snapshot,
      response: {
        ok: true,
        duplicate: false,
        purchase,
      },
    };
  });
});

app.post("/v1/campaign/begin", { preHandler: requireAstraAuth }, async (request, reply) => {
  const stage = Number(request.body?.stage);
  const requestId = String(request.body?.request_id || "").trim().slice(0, 120);

  const { config: adminConfig } = await loadVpsAdminConfig();
  const stages = loadCampaignStagesVps(adminConfig);

  if (
    !Number.isInteger(stage) ||
    stage < 0 ||
    stage >= stages.length ||
    stage >= MAX_CAMPAIGN_STAGES
  ) {
    return reply.code(400).send({
      ok: false,
      error: "Étape de campagne invalide.",
    });
  }

  const stageConfig = stages[stage];

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const campaign = normalizeCampaignProgressVps(snapshot.campaign_progress);

    const previousStageIndex =
      Number(stageConfig.stage_index || 0) > 0
        ? stages.findIndex(
            (entry) =>
              entry.campaign_id === stageConfig.campaign_id &&
              Number(entry.stage_index) ===
                Number(stageConfig.stage_index) - 1,
          )
        : -1;

    const previousStageCleared =
      previousStageIndex >= 0 &&
      Math.max(
        0,
        Number(
          campaign.stars?.[String(previousStageIndex)] || 0,
        ),
      ) > 0;

    if (
      Number(stageConfig.stage_index || 0) > 0 &&
      !previousStageCleared
    ) {
      throw makeHttpError(
        409,
        "Terminez d’abord la forteresse précédente de cette campagne.",
      );
    }

    const now = Date.now();
    const stageKey = String(stage);
    const cooldownHours = Math.max(
      0,
      Math.min(8760, Number(stageConfig.cooldownHours ?? 7)),
    );
    const energyCost = Math.max(
      0,
      Math.round(Number(stageConfig.energyCost ?? 5)),
    );

    const pending = Array.isArray(snapshot._vps_campaign_battles)
      ? snapshot._vps_campaign_battles
          .filter(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              Math.max(
                Number(entry.expires_at || 0),
                Number(entry.started_at || 0) + 30 * 60 * 1000,
              ) > now,
          )
          .slice(-19)
      : [];

    const activeSameStage = pending.find(
      (entry) => Number(entry.stage) === stage,
    );

    if (activeSameStage) {
      const sameRequest =
        requestId &&
        String(activeSameStage.request_id || "") === requestId;

      if (sameRequest) {
        return {
          write: false,
          response: {
            ok: true,
            resumed: true,
            battle_id: String(activeSameStage.battle_id || ""),
            battle_token: String(activeSameStage.battle_token || ""),
            energy_cost: Math.max(
              0,
              Number(activeSameStage.energy_cost || energyCost),
            ),
            cooldown_until: Math.max(
              0,
              Number(campaign.cooldowns?.[stageKey] || 0),
            ),
            campaign,
          },
        };
      }

      throw makeHttpError(
        409,
        "Un combat de cette forteresse est déjà en cours ou en attente de validation.",
      );
    }

    const existingCooldown = Math.max(
      0,
      Number(campaign.cooldowns?.[stageKey] || 0),
    );

    if (existingCooldown > now) {
      const error = makeHttpError(
        409,
        "Cette forteresse est encore verrouillée après votre précédent combat.",
      );
      error.cooldown_until = existingCooldown;
      error.campaign = campaign;
      throw error;
    }

    let energyState = materializeEnergyResources(
      snapshot.resources,
      now,
    );

    if (!energyState.initialized) {
      energyState = {
        ...energyState,
        initialized: true,
        energy: ENERGY_CAPACITY,
        revision: 1,
        updatedAt: now,
        resources: {
          ...energyState.resources,
          energy_initialized: true,
          energy: ENERGY_CAPACITY,
          energy_revision: 1,
          energy_updated_at: now,
        },
      };
    }

    if (energyState.energy < energyCost) {
      throw makeHttpError(
        409,
        "Énergie insuffisante pour cette forteresse.",
      );
    }

    const battleId = crypto.randomUUID();
    const battleToken = crypto.randomBytes(24).toString("hex");
    const durationSeconds = clampInt(
      stageConfig.duration || 180,
      30,
      600,
    );
    const cooldownUntil =
      cooldownHours > 0
        ? now + Math.round(cooldownHours * 60 * 60 * 1000)
        : 0;
    const expiresAt =
      now +
      Math.max(
        (durationSeconds + 120) * 1000,
        30 * 60 * 1000,
      );

    if (cooldownUntil > 0) {
      campaign.cooldowns[stageKey] = cooldownUntil;
    } else {
      delete campaign.cooldowns[stageKey];
    }

    snapshot._vps_campaign_battles = [
      ...pending,
      {
        battle_id: battleId,
        battle_token: battleToken,
        request_id: requestId,
        stage,
        energy_cost: energyCost,
        started_at: now,
        expires_at: expiresAt,
      },
    ].slice(-20);

    snapshot.resources = {
      ...energyState.resources,
      energy_initialized: true,
      energy: Math.max(0, energyState.energy - energyCost),
      energy_revision: Math.min(
        MAX_RESOURCE,
        energyState.revision + 1,
      ),
      energy_updated_at: now,
    };
    snapshot.campaign_progress = campaign;

    const savedAt = new Date(now).toISOString();
    snapshot.progression_version = Math.max(
      4,
      Number(snapshot.progression_version || 0),
    );
    snapshot.last_active_at = savedAt;
    snapshot.synced_at = savedAt;

    const pilotBattle = {
      battle_id: battleId,
      battle_token: battleToken,
      energy_cost: energyCost,
      started_at: now,
      expires_at: expiresAt,
      cooldown_until: cooldownUntil,
    };

    markVpsBackupPending(snapshot, savedAt, {
      action: "beginCampaign",
      stage,
      request_id: requestId,
      pilot_vps_backup: true,
      pilot_vps_battle: pilotBattle,
    });

    return {
      snapshot,
      response: {
        ok: true,
        battle_id: battleId,
        battle_token: battleToken,
        energy_cost: energyCost,
        cooldown_until: cooldownUntil,
        campaign,
        pilot_vps_battle: pilotBattle,
      },
    };
  });
});

app.post("/v1/dungeon/begin", { preHandler: requireAstraAuth }, async (request, reply) => {
  const dungeonId = String(request.body?.dungeon_id || "").trim().slice(0, 80);
  const battleId = String(request.body?.battle_id || "").trim().slice(0, 120);

  if (!/^dungeon_[a-z0-9_]+$/i.test(dungeonId)) {
    return reply.code(400).send({ ok: false, error: "Donjon invalide." });
  }
  if (!battleId) {
    return reply.code(400).send({
      ok: false,
      error: "Identifiant de combat manquant.",
    });
  }

  const { config: adminConfig } = await loadVpsAdminConfig();
  const configuredDungeon = Array.isArray(adminConfig?.dungeons)
    ? adminConfig.dungeons.find(
        (entry) => String(entry?.id || "") === dungeonId,
      )
    : null;

  if (!configuredDungeon) {
    return reply.code(404).send({
      ok: false,
      error: "Ce donjon n’est plus disponible.",
    });
  }

  const cooldownHours = Math.max(
    0,
    Math.min(8760, Number(configuredDungeon.cooldownHours ?? 0)),
  );

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const progress = normalizeDungeonProgressVps(snapshot.dungeon_progress);
    const previousSettlement = progress.settlements?.[battleId];

    if (previousSettlement) {
      return {
        write: false,
        response: {
          ok: true,
          cooldown_until: Number(previousSettlement.cooldown_until || 0),
          dungeon_progress: progress,
          duplicate: true,
        },
      };
    }

    const now = Date.now();
    const existingCooldown = Math.max(
      0,
      Number(progress.cooldowns?.[dungeonId] || 0),
    );

    if (existingCooldown > now) {
      const error = makeHttpError(
        409,
        "Ce donjon est encore en attente avant de pouvoir être rejoué.",
      );
      error.cooldown_until = existingCooldown;
      error.dungeon_progress = progress;
      throw error;
    }

    const cooldownUntil =
      cooldownHours > 0
        ? now + Math.round(cooldownHours * 60 * 60 * 1000)
        : 0;

    if (cooldownUntil > 0) {
      progress.cooldowns[dungeonId] = cooldownUntil;
    } else {
      delete progress.cooldowns[dungeonId];
    }

    progress.settlements = {
      [battleId]: {
        dungeon_id: dungeonId,
        stars: 0,
        cooldown_until: cooldownUntil,
      },
      ...(progress.settlements || {}),
    };
    progress.settlements = Object.fromEntries(
      Object.entries(progress.settlements).slice(0, 200),
    );

    snapshot.dungeon_progress = progress;
    snapshot.progression_version = Math.max(
      2,
      Number(snapshot.progression_version || 0),
    );
    const savedAt = new Date(now).toISOString();
    snapshot.last_active_at = savedAt;
    snapshot.synced_at = savedAt;

    const pilotDungeon = {
      started_at: now,
      cooldown_until: cooldownUntil,
    };

    markVpsBackupPending(snapshot, savedAt, {
      action: "beginDungeon",
      dungeon_id: dungeonId,
      battle_id: battleId,
      pilot_vps_backup: true,
      pilot_vps_dungeon: pilotDungeon,
    });

    return {
      snapshot,
      response: {
        ok: true,
        cooldown_until: cooldownUntil,
        dungeon_progress: progress,
        duplicate: false,
        pilot_vps_dungeon: pilotDungeon,
      },
    };
  });
});

app.post("/v1/campaign/resolve", { preHandler: requireAstraAuth }, async (request, reply) => {
  const stage = Number(request.body?.stage);
  const stars = clampInt(request.body?.stars, 0, 3);
  let battleId = String(request.body?.battle_id || "").trim().slice(0, 120);
  let battleToken = String(request.body?.battle_token || "").trim().slice(0, 160);

  const { config: adminConfig } = await loadVpsAdminConfig();
  const stages = loadCampaignStagesVps(adminConfig);

  if (
    !Number.isInteger(stage) ||
    stage < 0 ||
    stage >= stages.length ||
    stage >= MAX_CAMPAIGN_STAGES
  ) {
    return reply.code(400).send({
      ok: false,
      error: "Étape de campagne invalide.",
    });
  }

  const stageConfig = stages[stage];

  return mutateLockedVillage(request, reply, async (snapshot) => {
    const campaign = normalizeCampaignProgressVps(snapshot.campaign_progress);
    const previousSettlement = campaign.settlements?.[battleId];

    if (previousSettlement) {
      const resources =
        snapshot.resources &&
        typeof snapshot.resources === "object" &&
        !Array.isArray(snapshot.resources)
          ? snapshot.resources
          : {};
      return {
        write: false,
        response: {
          ok: true,
          first_clear: previousSettlement.first_clear === true,
          cooldown_until: Number(previousSettlement.cooldown_until || 0),
          reward: normalizeCampaignRewardVps(previousSettlement.reward),
          first_clear_reward: normalizeCampaignRewardVps(
            previousSettlement.first_clear_reward,
          ),
          evolution_essence: clampInt(
            resources.evolution_essence,
            0,
            MAX_RESOURCE,
          ),
          evolution_essence_revision: clampInt(
            resources.evolution_essence_revision,
            0,
            MAX_RESOURCE,
          ),
          campaign,
          duplicate: true,
        },
      };
    }

    const reservations = Array.isArray(snapshot._vps_campaign_battles)
      ? snapshot._vps_campaign_battles.filter(
          (entry) => entry && typeof entry === "object",
        )
      : [];

    let reservation = reservations.find(
      (entry) =>
        String(entry.battle_id || "") === battleId &&
        String(entry.battle_token || "") === battleToken &&
        Number(entry.stage) === stage,
    );

    const resolveNow = Date.now();

    if (!reservation) {
      const sameStageActive = reservations
        .filter(
          (entry) =>
            Number(entry.stage) === stage &&
            Math.max(
              Number(entry.expires_at || 0),
              Number(entry.started_at || 0) + 30 * 60 * 1000,
            ) > resolveNow,
        )
        .sort(
          (a, b) =>
            Number(b.started_at || 0) -
            Number(a.started_at || 0),
        );

      if (sameStageActive.length === 1) {
        reservation = sameStageActive[0];
      }
    }

    if (!reservation) {
      const recentSettlement = Object.entries(
        campaign.settlements || {},
      )
        .map(([id, value]) => ({ id, ...(value || {}) }))
        .filter(
          (entry) =>
            Number(entry.stage) === stage &&
            Number(entry.settled_at || 0) >
              resolveNow - 5 * 60 * 1000,
        )
        .sort(
          (a, b) =>
            Number(b.settled_at || 0) -
            Number(a.settled_at || 0),
        )[0];

      if (recentSettlement) {
        return {
          write: false,
          response: {
            ok: true,
            recovered: true,
            duplicate: true,
            first_clear: recentSettlement.first_clear === true,
            cooldown_until: Number(recentSettlement.cooldown_until || 0),
            reward: normalizeCampaignRewardVps(recentSettlement.reward),
            first_clear_reward: normalizeCampaignRewardVps(
              recentSettlement.first_clear_reward,
            ),
            campaign,
          },
        };
      }

      const error = makeHttpError(
        409,
        "Ce combat n’a pas pu être retrouvé. Relancez simplement la forteresse.",
      );
      error.recoverable = true;
      error.campaign = campaign;
      throw error;
    }

    battleId = String(reservation.battle_id || battleId || "").slice(0, 120);
    battleToken = String(reservation.battle_token || battleToken || "").slice(0, 160);

    const reservationValidUntil = Math.max(
      Number(reservation.expires_at || 0),
      Number(reservation.started_at || 0) + 30 * 60 * 1000,
    );

    if (reservationValidUntil <= resolveNow) {
      const error = makeHttpError(
        409,
        "Cette réservation de combat a expiré. Relancez simplement la forteresse.",
      );
      error.recoverable = true;
      error.campaign = campaign;
      throw error;
    }

    const previousStageIndex =
      Number(stageConfig.stage_index || 0) > 0
        ? stages.findIndex(
            (entry) =>
              entry.campaign_id === stageConfig.campaign_id &&
              Number(entry.stage_index) ===
                Number(stageConfig.stage_index) - 1,
          )
        : -1;

    const previousStageCleared =
      previousStageIndex >= 0 &&
      Math.max(
        0,
        Number(campaign.stars?.[String(previousStageIndex)] || 0),
      ) > 0;

    if (
      Number(stageConfig.stage_index || 0) > 0 &&
      !previousStageCleared
    ) {
      throw makeHttpError(
        409,
        "Terminez d’abord la forteresse précédente de cette campagne.",
      );
    }

    const stageKey = String(stage);
    const existingCooldown = Math.max(
      0,
      Number(campaign.cooldowns?.[stageKey] || 0),
    );
    const oldStars = Math.max(
      0,
      Number(campaign.stars?.[stageKey] || 0),
    );
    const firstClear = stars > 0 && oldStars <= 0;
    const cooldownHours = Math.max(
      0,
      Math.min(8760, Number(stageConfig.cooldownHours ?? 7)),
    );
    const cooldownUntil =
      existingCooldown > resolveNow
        ? existingCooldown
        : cooldownHours > 0
          ? resolveNow +
            Math.round(cooldownHours * 60 * 60 * 1000)
          : 0;

    if (cooldownUntil > 0) {
      campaign.cooldowns[stageKey] = cooldownUntil;
    } else {
      delete campaign.cooldowns[stageKey];
    }

    if (stars > 0) {
      campaign.stars[stageKey] = Math.max(oldStars, stars);
      campaign.unlocked = Math.min(
        Math.max(0, stages.length - 1),
        Math.max(campaign.unlocked, stage + 1),
      );
    }

    const reward =
      stars > 0
        ? normalizeCampaignRewardVps(stageConfig.reward)
        : {};
    const firstClearReward = firstClear
      ? normalizeCampaignRewardVps(stageConfig.firstClearReward)
      : {};

    snapshot._vps_campaign_battles = reservations
      .filter(
        (entry) =>
          String(entry.battle_id || "") !== battleId,
      )
      .filter(
        (entry) =>
          Number(entry.expires_at || 0) > resolveNow,
      )
      .slice(-20);

    const inventory = snapshotInventory(snapshot);
    const sensitiveReward = {};

    for (const sourceReward of [reward, firstClearReward]) {
      const gems = Math.max(
        0,
        Math.floor(Number(sourceReward?.gems || 0)),
      );
      if (gems > 0) {
        sensitiveReward.gems = Math.min(
          MAX_RESOURCE,
          Number(sensitiveReward.gems || 0) + gems,
        );
      }

      for (const chestId of SECURE_CHEST_IDS) {
        const amount = Math.max(
          0,
          Math.floor(Number(sourceReward?.[chestId] || 0)),
        );
        if (amount > 0) {
          sensitiveReward[chestId] = Math.min(
            MAX_RESOURCE,
            Number(sensitiveReward[chestId] || 0) + amount,
          );
        }
      }
    }

    if (Number(sensitiveReward.gems || 0) > 0) {
      const resources = ensureSnapshotResources(snapshot);
      resources.gems = Math.min(
        MAX_GEMS,
        Number(resources.gems || 0) +
          Number(sensitiveReward.gems || 0),
      );
      resources.gems_revision = Math.min(
        MAX_RESOURCE,
        Number(resources.gems_revision || 0) + 1,
      );
      snapshot.resources = resources;
    }

    for (const chestId of SECURE_CHEST_IDS) {
      const amount = Math.max(
        0,
        Math.floor(Number(sensitiveReward[chestId] || 0)),
      );
      if (amount > 0) {
        inventory[chestId] = Math.min(
          MAX_RESOURCE,
          clampInt(inventory[chestId], 0, MAX_RESOURCE) +
            amount,
        );
      }
    }
    snapshot.inventory = inventory;

    let resources =
      snapshot.resources &&
      typeof snapshot.resources === "object" &&
      !Array.isArray(snapshot.resources)
        ? { ...snapshot.resources }
        : {};

    const evolutionEssenceGain =
      Math.max(
        0,
        Math.floor(Number(reward.evolutionEssence || 0)),
      ) +
      Math.max(
        0,
        Math.floor(
          Number(firstClearReward.evolutionEssence || 0),
        ),
      );

    if (evolutionEssenceGain > 0) {
      const balance = clampInt(
        resources.evolution_essence,
        0,
        MAX_RESOURCE,
      );
      const revision = clampInt(
        resources.evolution_essence_revision,
        0,
        MAX_RESOURCE,
      );
      resources.evolution_essence_initialized = true;
      resources.evolution_essence = Math.min(
        MAX_RESOURCE,
        balance + evolutionEssenceGain,
      );
      resources.evolution_essence_revision = Math.min(
        MAX_RESOURCE,
        revision + 1,
      );
    }

    snapshot.resources = resources;

    campaign.settlements = {
      [battleId]: {
        stage,
        stars,
        first_clear: firstClear,
        cooldown_until: cooldownUntil,
        settled_at: resolveNow,
        reward,
        first_clear_reward: firstClearReward,
      },
      ...(campaign.settlements || {}),
    };
    campaign.settlements = Object.fromEntries(
      Object.entries(campaign.settlements).slice(0, 300),
    );
    snapshot.campaign_progress = campaign;

    const savedAt = new Date(resolveNow).toISOString();
    snapshot.progression_version = Math.max(
      4,
      Number(snapshot.progression_version || 0),
    );
    snapshot.last_active_at = savedAt;
    snapshot.synced_at = savedAt;

    const pilotResult = {
      first_clear: firstClear,
      cooldown_until: cooldownUntil,
      reward,
      first_clear_reward: firstClearReward,
      settled_at: resolveNow,
    };

    markVpsBackupPending(snapshot, savedAt, {
      action: "resolveCampaign",
      stage,
      stars,
      battle_id: battleId,
      battle_token: battleToken,
      pilot_vps_backup: true,
      pilot_vps_result: pilotResult,
    });

    return {
      snapshot,
      response: {
        ok: true,
        first_clear: firstClear,
        cooldown_until: cooldownUntil,
        reward,
        first_clear_reward: firstClearReward,
        evolution_essence: clampInt(
          resources.evolution_essence,
          0,
          MAX_RESOURCE,
        ),
        evolution_essence_revision: clampInt(
          resources.evolution_essence_revision,
          0,
          MAX_RESOURCE,
        ),
        campaign,
        duplicate: false,
        pilot_vps_result: pilotResult,
      },
    };
  });
});

app.get("/v1/config", { preHandler: requireAstraAuth }, async () => {
  const result = await pool.query(
    `SELECT revision, value, updated_at
       FROM astra_settings
      WHERE setting_key = 'astra_admin_config'
      LIMIT 1`,
  );

  if (!result.rowCount) {
    return {
      ok: true,
      config: null,
      revision: 0,
      source: "vps",
    };
  }

  const row = result.rows[0];
  return {
    ok: true,
    config: row.value,
    revision: Number(row.revision || 0),
    updated_at: row.updated_at,
    source: "vps",
  };
});

app.put("/v1/admin/config", { preHandler: requireAstraAuth }, async (request, reply) => {
  const user = request.astraUser;
  if (
    String(user?.email || "").trim().toLowerCase() !== ASTRA_ADMIN_EMAIL &&
    String(user?.role || "").trim().toLowerCase() !== "admin"
  ) {
    return reply.code(403).send({
      ok: false,
      error: "Accès administrateur refusé.",
    });
  }

  const config = request.body?.config;
  const expectedRevision = Number(request.body?.expected_revision ?? 0);

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return reply.code(400).send({
      ok: false,
      error: "Configuration ASTRAL invalide.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT revision
         FROM astra_settings
        WHERE setting_key = 'astra_admin_config'
        FOR UPDATE`,
    );

    const revision = current.rowCount
      ? Number(current.rows[0].revision || 0)
      : 0;

    if (current.rowCount && revision !== expectedRevision) {
      await client.query("ROLLBACK");
      return reply.code(409).send({
        ok: false,
        error: "Conflit de configuration.",
        current_revision: revision,
      });
    }

    const nextRevision = revision + 1;

    await client.query(
      `INSERT INTO astra_settings (setting_key, revision, value, updated_at)
       VALUES ('astra_admin_config', $1, $2::jsonb, NOW())
       ON CONFLICT (setting_key)
       DO UPDATE SET revision = EXCLUDED.revision,
                     value = EXCLUDED.value,
                     updated_at = NOW()`,
      [nextRevision, JSON.stringify(config)],
    );

    await client.query("COMMIT");

    return {
      ok: true,
      revision: nextRevision,
      updated_at: new Date().toISOString(),
      source: "vps",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/backend-status", { preHandler: requireAstraAuth }, async (request) => {
  const key = `astra:status:${request.astraUser.email}`;
  const visits = await redis.incr(key);
  if (visits === 1) await redis.expire(key, 3600);
  return {
    ok: true,
    database: "postgresql",
    cache: "redis",
    authenticated: true,
    status_checks_last_hour: visits,
  };
});

registerVpsLoadTest(app, { pool, redis, requireAstraAuth });

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const status = Number(error?.statusCode || 500);
  const payload = {
    ok: false,
    error:
      status >= 500
        ? "Erreur serveur ASTRAL."
        : String(error?.message || error),
  };

  for (const key of [
    "cooldown_until",
    "campaign",
    "dungeon_progress",
    "recoverable",
    "stale_gems",
  ]) {
    if (error?.[key] !== undefined) {
      payload[key] = error[key];
    }
  }

  reply
    .code(status >= 400 && status < 600 ? status : 500)
    .send(payload);
});

const port = Number(process.env.PORT || 3001);
await app.listen({ host: "0.0.0.0", port });