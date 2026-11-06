// Lists OpenRouter models that can run this bot, cheapest first. Needs no API key.
interface CatalogModel {
  id: string;
  context_length?: number;
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
}

export {};

const REQUIRED = ["tools", "response_format"];
const MIN_CONTEXT = 200_000;

const response = await fetch("https://openrouter.ai/api/v1/models");
if (!response.ok) throw new Error(`OpenRouter returned ${response.status}`);
const { data } = (await response.json()) as { data: CatalogModel[] };

const perMillion = (value: string | undefined) => Number(value ?? 0) * 1_000_000;

const rows = data
  .filter((model) => REQUIRED.every((parameter) => model.supported_parameters?.includes(parameter)))
  .filter((model) => model.architecture?.input_modalities?.includes("image"))
  .filter((model) => (model.context_length ?? 0) >= MIN_CONTEXT)
  .filter((model) => perMillion(model.pricing?.prompt) > 0)
  .filter((model) => !model.id.endsWith(":batch")) // Batch models are too slow for chat.
  .map((model) => ({
    id: model.id,
    context: model.context_length,
    usd_in_per_m: Number(perMillion(model.pricing?.prompt).toFixed(3)),
    usd_out_per_m: Number(perMillion(model.pricing?.completion).toFixed(3)),
  }))
  .sort((a, b) => a.usd_in_per_m + a.usd_out_per_m / 4 - (b.usd_in_per_m + b.usd_out_per_m / 4));

console.log(`${rows.length} of ${data.length} models qualify. Cheapest 15:`);
console.table(rows.slice(0, 15));
