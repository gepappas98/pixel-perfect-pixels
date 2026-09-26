/**
 * Server-only AI client — Groq.
 *
 * Uses the user's Groq API key directly.
 * The API key must remain server-side and must NEVER be exposed to the client.
 *
 * Current model:
 * openai/gpt-oss-20b
 *
 * This model is used through Groq's OpenAI-compatible API.
 */

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_CHAT_URL = `${GROQ_BASE_URL}/chat/completions`;
const GROQ_MODELS_URL = `${GROQ_BASE_URL}/models`;

export const AI_MODEL = "groq/openai/gpt-oss-20b";

/**
 * Groq's actual API model identifier.
 *
 * IMPORTANT:
 * AI_MODEL above is the internal/display identifier used by this project.
 * Groq itself expects:
 *
 * openai/gpt-oss-20b
 */
const GROQ_MODEL = "openai/gpt-oss-20b";

type GroqModel = {
  id?: string;
  object?: string;
  owned_by?: string;
};

type GroqModelsResponse = {
  data?: GroqModel[];
};

type GroqChatResponse = {
  choices?: {
    message?: {
      content?: string;
    };
  }[];
};

/**
 * Verify that the configured model is available for the current
 * GROQ_API_KEY.
 *
 * This prevents confusing "model_not_found" errors when Groq changes
 * model availability.
 */
async function verifyGroqModel(
  apiKey: string,
): Promise<void> {
  const res = await fetch(GROQ_MODELS_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");

    if (res.status === 401) {
      throw new Error(
        "Groq API key invalid — check GROQ_API_KEY in environment secrets.",
      );
    }

    if (res.status === 429) {
      throw new Error(
        "Groq rate limited while checking available models — retry shortly.",
      );
    }

    throw new Error(
      `Groq model availability check failed: HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as GroqModelsResponse;

  const models = Array.isArray(json.data) ? json.data : [];

  const available = models.some(
    (model) => model.id === GROQ_MODEL,
  );

  if (!available) {
    throw new Error(
      `Groq model "${GROQ_MODEL}" is not available for this API key.`,
    );
  }
}

/**
 * Ask Groq AI.
 *
 * Server-only function.
 *
 * The GROQ_API_KEY is read exclusively from the server environment.
 */
export async function askLovableAI(
  prompt: string,
  instructions?: string,
): Promise<string> {
  const apiKey = process.env["GROQ_API_KEY"];

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const messages: { role: string; content: string }[] = [];

  if (instructions) {
    messages.push({
      role: "system",
      content: instructions,
    });
  } else {
    messages.push({
      role: "system",
      content:
        "You are a concise, expert crypto trading analyst. Be direct and specific. No disclaimers.",
    });
  }

  messages.push({
    role: "user",
    content: prompt,
  });

  /*
   * Verify model availability before making the completion request.
   *
   * This specifically prevents the old:
   *
   * llama-3.3-70b-versatile
   *
   * model_not_found error.
   */
  await verifyGroqModel(apiKey);

  const res = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 1024,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");

    if (res.status === 429) {
      throw new Error(
        "Groq rate limited — wait a few seconds and retry.",
      );
    }

    if (res.status === 401) {
      throw new Error(
        "Groq API key invalid — check GROQ_API_KEY in environment secrets.",
      );
    }

    if (res.status === 404) {
      throw new Error(
        `Groq model "${GROQ_MODEL}" is unavailable for this API key.`,
      );
    }

    throw new Error(
      `Groq HTTP ${res.status}: ${body.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as GroqChatResponse;

  const text =
    json.choices?.[0]?.message?.content ?? "";

  if (!text) {
    throw new Error("Empty response from Groq");
  }

  return text.trim();
}
