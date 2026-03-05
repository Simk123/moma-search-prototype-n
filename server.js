import "dotenv/config";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

// ─── Load JSON data into memory on startup ────────────────────────────────────
console.log("Loading museum data...");
const DATA_PATH = join(__dirname, "museum_data_cleaned.json");
let ALL_ITEMS = [];

try {
  const raw = readFileSync(DATA_PATH, "utf-8");
  ALL_ITEMS = JSON.parse(raw);
  console.log(`Loaded ${ALL_ITEMS.length} items from JSON`);
} catch (e) {
  console.error("Failed to load museum_data_cleaned.json:", e.message);
  console.error("Make sure museum_data_cleaned.json is in the same folder as server.js");
}

// ─── Related terms for broad topic searches ───────────────────────────────────
const RELATED_TERMS = {
  fauvism:                   ["matisse", "derain", "vlaminck", "color", "fauvist"],
  cubism:                    ["picasso", "braque", "cubist", "geometric", "collage"],
  surrealism:                ["dali", "magritte", "surrealist", "dream", "ernst"],
  impressionism:             ["monet", "renoir", "impressionist", "light", "landscape"],
  expressionism:             ["kirchner", "expressionist", "emotion", "distortion"],
  "abstract expressionism":  ["pollock", "de kooning", "rothko", "abstract", "gesture"],
  dada:                      ["duchamp", "collage", "readymade", "absurd", "anti-art"],
  minimalism:                ["judd", "minimal", "geometric", "reduction", "form"],
  "pop art":                 ["warhol", "lichtenstein", "popular", "consumer", "print"],
  "contemporary art":        ["contemporary", "modern", "installation", "video", "digital"],
  "abstract art":            ["abstract", "non-representational", "form", "color", "shape"],
  photography:               ["photograph", "camera", "lens", "darkroom", "film"],
  "women photographers":     ["photographer", "woman", "female", "portrait", "documentary"],
  sculpture:                 ["sculpture", "bronze", "marble", "three-dimensional", "cast"],
  drawing:                   ["drawing", "sketch", "pencil", "ink", "paper"],
  printmaking:               ["print", "lithograph", "etching", "woodcut", "screen"],
  architecture:              ["architect", "building", "design", "space", "structure"],
  design:                    ["design", "graphic", "industrial", "product", "typography"],
  film:                      ["film", "cinema", "video", "moving image", "director"],
  performance:               ["performance", "body", "action", "live", "event"],
};

function getRelatedTerms(query) {
  const q = query.toLowerCase().trim();
  if (RELATED_TERMS[q]) return RELATED_TERMS[q];
  for (const [key, terms] of Object.entries(RELATED_TERMS)) {
    if (q.includes(key) || key.includes(q)) return terms;
  }
  return [];
}

// ─── In-memory search ─────────────────────────────────────────────────────────
function searchItems(query, limit = 30) {
  const q = query.toLowerCase().trim();
  const related = getRelatedTerms(query);

  const scored = ALL_ITEMS.map(item => {
    const title   = (item.title   ?? "").toLowerCase();
    const summary = (item.summary ?? "").toLowerCase();
    const content = (item.content ?? "").toLowerCase();

    let score = 0;

    if (title.includes(q))   score += 10;
    if (summary.includes(q)) score += 5;
    if (content.includes(q)) score += 3;

    for (const term of related) {
      if (title.includes(term))   score += 3;
      if (summary.includes(term)) score += 2;
      if (content.includes(term)) score += 1;
    }

    if (item.image_url && item.image_url.trim() !== "") score += 2;

    return { ...item, _score: score };
  });

  const matches = scored
    .filter(item => item._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...item }) => item);

  const withImages = matches.filter(r => r.image_url && r.image_url.trim() !== "");
  if (withImages.length < 6) {
    const existingIds = new Set(matches.map(r => r.id));
    const extras = ALL_ITEMS
      .filter(r => r.image_url && r.image_url.trim() !== "" && !existingIds.has(r.id))
      .sort(() => Math.random() - 0.5)
      .slice(0, 12 - withImages.length);
    return [...matches, ...extras].slice(0, limit);
  }

  return matches;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/search", (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query) return res.status(400).json({ error: "Missing ?q=" });
  const results = searchItems(query, 10);
  return res.json({ results });
});

app.get("/search/editorial", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query) return res.status(400).json({ error: "Missing ?q=" });

  try {
    // 1. Search the full JSON dataset
    const results = searchItems(query, 30);

    // 2. Separate image pool for fallback
    const imagePool = results.filter(r => r.image_url && r.image_url.trim() !== "");

    console.log(`Query: "${query}" | Results: ${results.length} | With images: ${imagePool.length}`);

    // 3. Build prompt context — keep it small to avoid Haiku JSON corruption
    const resultsContext = results.length === 0
      ? `NOTE: No matching records found for "${query}" in the MoMA dataset.
Generate accurate editorial content about "${query}" from your knowledge of MoMA's collection and art history.
Set ALL image_url fields to null.`
      : `SEARCH RESULTS (sorted by relevance):
${JSON.stringify(results.slice(0, 12).map(r => ({
  id: r.id,
  type: r.type,
  title: r.title,
  summary: r.summary?.slice(0, 40) || "",
  image_url: r.image_url || null,
})), null, 2)}`;

    const prompt = `You are an editorial AI for MoMA. Generate a structured JSON response for this search.

SEARCH QUERY: "${query}"

${resultsContext}

LAYOUT TYPE — pick exactly one:
- "artist"     → query is a specific person's name (e.g. "Cindy Sherman", "Van Gogh", "Lee Krasner")
- "exhibition" → query is about a specific exhibition or event (e.g. "Femme Camp", "Our Selves")
- "general"    → query is a theme, movement, medium, or broad topic (e.g. "women photographers", "fauvism", "time")

FIELD RULES:
- overview: 2-3 sentences relevant to "${query}"
- artists: up to 3 items — each { id, type: "Artist", title, summary (max 10 words), image_url }
- articles: up to 6 items — each { id, type: "Article", title, summary (max 10 words), image_url }
- thematic_explorations: exactly 3 items — each { title (max 4 words), description (max 12 words), count }
- history: exactly 3 items — each { period (max 4 words), description (max 12 words) }
- on_view: exactly 3 items — each { floor (number only), description (max 8 words), count }
- image_url: ONLY use values from the search results above. NEVER invent URLs. Set null if unavailable.

Return this exact shape:
{
  "layout_type": "general",
  "overview": "string",
  "artists": [],
  "articles": [],
  "thematic_explorations": [],
  "history": [],
  "on_view": []
}`;

    // 4. Call Claude with system prompt + reduced max_tokens
    const message = await Promise.race([
      anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        stream: false,   // ← add this
        system: "You are a JSON API. Output ONLY raw valid JSON...",
        messages: [{ role: "user", content: prompt }],
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Claude API timeout after 28s")), 28000)
      ),
    ]);

    const text = message.content.find((b) => b.type === "text")?.text ?? "";

    // Strip markdown fences just in case
    const stripped = text
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    // Extract JSON object boundaries as last resort
    const jsonStart = stripped.indexOf("{");
    const jsonEnd   = stripped.lastIndexOf("}");
    const jsonStr   = (jsonStart !== -1 && jsonEnd !== -1)
      ? stripped.slice(jsonStart, jsonEnd + 1)
      : stripped;

    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error("JSON parse failed. Raw response:\n", text);
      return res.status(500).json({ error: "Failed to parse Claude response" });
    }

    // 5. Assign real images from shuffled pool (ignore Claude's image choices)
    const shuffled = [...imagePool].sort(() => Math.random() - 0.5);
    let imgIdx = 0;
    const nextImage = () => {
      if (shuffled.length === 0) return null;
      const img = shuffled[imgIdx % shuffled.length].image_url;
      imgIdx++;
      return img;
    };

    data.articles = (data.articles ?? []).map(item => ({ ...item, image_url: nextImage() }));
    data.artists  = (data.artists  ?? []).map(item => ({ ...item, image_url: nextImage() }));

    return res.json(data);
  } catch (e) {
    console.error("/search/editorial error:", e.message);
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));