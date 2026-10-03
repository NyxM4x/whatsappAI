import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_BUSINESS_SLUG } from "../lib/clinic/config";
import { defaultServices, type ServiceItem } from "../lib/clinic/services";
import { getSupabaseClient } from "../lib/engine/clients";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^"|"$/g, "");
    }
  }
}

const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`BLOCKED: no production catalog comparison; missing ${missing.join(", ")}.`);
  process.exit(2);
}

type CatalogItem = {
  name: string;
  price: string;
  priceMax: string;
  note: string;
  category: string;
  aliases: string[];
  promo: string;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]),
  );
}

function normalizeCatalog(items: unknown): Map<string, CatalogItem> | null {
  if (!Array.isArray(items)) return null;
  const catalog = new Map<string, CatalogItem>();
  for (const item of items) {
    if (!item || typeof item !== "object" || typeof item.name !== "string") return null;
    const service = item as ServiceItem;
    const name = service.name.normalize("NFC");
    if (catalog.has(name)) console.log(`DUPLICATE NAME: ${name}`);
    catalog.set(name, {
      name,
      price: String(service.price ?? ""),
      priceMax: String(service.priceMax ?? ""),
      note: String(service.note ?? ""),
      category: String(service.category ?? ""),
      // NFC: la misma "ñ" puede venir como un carácter o como n + tilde, y
      // comparadas en crudo darían una diferencia que no existe.
      aliases: [...(Array.isArray(service.aliases) ? service.aliases : [])].map((a) => String(a).normalize("NFC")).sort(),
      promo: JSON.stringify(stableValue(service.promo ?? null)),
    });
  }
  return catalog;
}

const supabase = getSupabaseClient();
const { data, error } = await supabase
  .from("clinic_settings")
  .select("services")
  .eq("business", DEFAULT_BUSINESS_SLUG)
  .maybeSingle();

if (error || !data || !Array.isArray(data.services) || data.services.length === 0) {
  console.error("BLOCKED: could not read a non-empty production services catalog from clinic_settings.");
  if (error?.code) console.error(`Supabase error code: ${error.code}`);
  process.exit(2);
}

const codeCatalog = normalizeCatalog(defaultServices);
const productionCatalog = normalizeCatalog(data.services);
if (!codeCatalog || !productionCatalog) {
  console.error("BLOCKED: one of the catalogs has an invalid structure.");
  process.exit(2);
}

let differences = 0;
for (const [name, codeItem] of codeCatalog) {
  const productionItem = productionCatalog.get(name);
  if (!productionItem) {
    differences++;
    console.log(`MISSING IN PRODUCTION: ${name}`);
    continue;
  }
  if (codeItem.price !== productionItem.price) {
    differences++;
    console.log(`PRICE DIFF: ${name} | code=${codeItem.price} | production=${productionItem.price}`);
  }
  if (codeItem.priceMax !== productionItem.priceMax) {
    differences++;
    console.log(`PRICE RANGE DIFF: ${name} | code=${codeItem.priceMax || "none"} | production=${productionItem.priceMax || "none"}`);
  }
  if (codeItem.note !== productionItem.note) {
    differences++;
    console.log(`NOTE DIFF: ${name}`);
  }
  if (codeItem.category !== productionItem.category) {
    differences++;
    console.log(`CATEGORY DIFF: ${name} | code=${codeItem.category} | production=${productionItem.category}`);
  }
  if (codeItem.promo !== productionItem.promo) {
    differences++;
    console.log(`PROMO DIFF: ${name}`);
  }
  if (JSON.stringify(codeItem.aliases) !== JSON.stringify(productionItem.aliases)) {
    differences++;
    const onlyCode = codeItem.aliases.filter((a) => !productionItem.aliases.includes(a));
    const onlyProduction = productionItem.aliases.filter((a) => !codeItem.aliases.includes(a));
    console.log(`ALIAS DIFF: ${name} | solo en código: ${JSON.stringify(onlyCode)} | solo en producción: ${JSON.stringify(onlyProduction)}`);
  }
}

for (const name of productionCatalog.keys()) {
  if (!codeCatalog.has(name)) {
    differences++;
    console.log(`PRODUCTION ONLY: ${name}`);
  }
}

if (differences) {
  console.error(`Catalog drift found: ${differences} difference(s). Review with the clinic before syncing.`);
  process.exitCode = 1;
} else {
  console.log(`Catalogs match for ${codeCatalog.size} service(s) (${DEFAULT_BUSINESS_SLUG}).`);
}