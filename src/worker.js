import {
  DEFAULT_MODEL,
  MODELS,
  PROMPT_1,
  PROMPT_2,
  PROMPT_3
} from "./config.js";

function resp(body, contentType = "text/plain; charset=utf-8", status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      ...extraHeaders
    }
  });
}

function isAllowedModel(modelId) {
  return MODELS.some((m) => m.id === modelId);
}

function builtinPromptForModel(modelId) {
  const meta = MODELS.find((m) => m.id === modelId);
  const persona = meta?.persona ?? 1;

  if (persona === 3) return PROMPT_3;
  if (persona === 2) return PROMPT_2;
  return PROMPT_1;
}

function clientConfigJs() {
  const models = MODELS.map((m) => ({
    id: m.id,
    label: m.label
  }));

  return `window.APP_MODELS = ${JSON.stringify(models, null, 2)};
window.APP_DEFAULT_MODEL = ${JSON.stringify(DEFAULT_MODEL)};
`;
}

async function handleChat(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return resp("Bad JSON", "text/plain; charset=utf-8", 400);
  }

  const requestedModel = payload?.model;
  const modelConfig = MODELS.find(m => m.id === requestedModel);
  const model = modelConfig ? requestedModel : DEFAULT_MODEL;
  const platform = modelConfig?.platform || 'nvidia';

  const realModelName = platform === 'deepseek'
    ? (model.includes('/') ? model.split('/').slice(1).join('/') : model)
    : model;

  let apiKey, baseUrl;
  if (platform === 'deepseek') {
    apiKey = env.DEEPSEEK_API_KEY;
    baseUrl = env.OPENAI_BASE_URL || 'https://api.deepseek.com';
  } else {
    apiKey = env.NVIDIA_API_KEY;
    baseUrl = 'https://integrate.api.nvidia.com/v1';
  }

  if (!apiKey) {
    return resp("Missing API Key for selected model.", "text/plain; charset=utf-8", 500);
  }

  const useBuiltinPersona = payload?.use_builtin_persona !== false;
  const customSystemPrompt =
    typeof payload?.custom_system_prompt === "string"
      ? payload.custom_system_prompt.trim()
      : "";

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const upstreamMessages = [];

  if (useBuiltinPersona) {
    upstreamMessages.push({
      role: "system",
      content: builtinPromptForModel(model)
    });
  } else if (customSystemPrompt) {
    upstreamMessages.push({
      role: "system",
      content: customSystemPrompt
    });
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    upstreamMessages.push({
      role: msg.role,
      content: typeof msg.content === "string" ? msg.content : ""
    });
  }

  // ── 核心改动：非流式获取 → 模拟流式输出 ──
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);

  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    signal: controller.signal,
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: realModelName,
      stream: false,  // 关掉流式，要求一次性完整回复
      messages: upstreamMessages,
      max_tokens: 8192  // 先小点测试，成功后可以改回 8192 或更大
    })
  });

  clearTimeout(timeoutId);

  if (!upstream.ok) {
    const errorText = await upstream.text().catch(() => "");
    return resp(
      `Upstream error ${upstream.status}: ${errorText}`,
      "text/plain; charset=utf-8",
      502
    );
  }

  const data = await upstream.json();
  const fullText = data.choices?.[0]?.message?.content || "";

  // 把完整文本拆成小块，模拟流式发给前端
  const encoder = new TextEncoder();
  let index = 0;
  const chunkSize = 10; // 每次发10个字
  const readable = new ReadableStream({
    async pull(controller) {
      if (index < fullText.length) {
        const chunk = fullText.substring(index, index + chunkSize);
        index += chunkSize;
        const sseData = `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
        controller.enqueue(encoder.encode(sseData));
      } else {
        // 发送结束信号
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    }
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    }
  });
}

export default {
  async fetch(request, env) {
     // ========== 密码保护开始 ==========
    const BASIC_USER = env.BASIC_USER;
    const BASIC_PASS = env.BASIC_PASS;
    if (!BASIC_USER || !BASIC_PASS) {
      return new Response('Server config error', { status: 500 });
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return new Response('Unauthorized', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="AI Chat Site"'
        }
      });
    }

    const encodedCredentials = authHeader.split(' ')[1];
    const decodedCredentials = atob(encodedCredentials);
    const [providedUser, providedPass] = decodedCredentials.split(':');

    if (providedUser !== BASIC_USER || providedPass !== BASIC_PASS) {
      return new Response('Unauthorized', { status: 401 });
    }
    // ========== 密码保护结束 ==========
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/config.js") {
      return resp(clientConfigJs(), "text/javascript; charset=utf-8");
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      return handleChat(request, env);
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return resp(
      "Static assets binding 'ASSETS' is missing. Please configure [assets] in wrangler.toml.",
      "text/plain; charset=utf-8",
      500
    );
  }
};
