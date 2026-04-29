export const config = { runtime: "nodejs" };

const COZE_API_BASE = "https://api.coze.cn";
const MAX_POLLS = 24;
const POLL_INTERVAL_MS = 800;

const siteContext = `
刘海个人网站资料：
- 刘海，AI 原生全栈开发者，CAAC 无人机机长执照持有者。
- 上一份工作：福华创新无人机有限公司，无人机技术员，2025.08-2026.02。
- 本科：华南师范大学，环境艺术设计。
- 有大疆 M300/M210 外场经验，做过无人机技术支持、方案表达、客户培训与现场交付。
- 核心项目：大模型驱动的无人机集群自动化调度系统。
- 项目链路：飞书消息 -> Coze/Agent 解析 -> 地图/天气 API -> FastAPI 云端服务 -> 本地 listener 轮询 -> MAVSDK/MAVLink 控制 PX4 -> AirSim 控制 UE4 虚拟飞机 -> Gazebo + UE4 双仿真验证。
- PX4 二次开发：自定义 DroneTaskStatus 消息，自定义 drone_task_manager 模块，继承 ScheduledWorkItem，1Hz 广播任务状态，完成 Kconfig、CMakeLists、编译和 pxh 控制台验证。
- 落地场景：园区/厂区巡逻、光伏/电力/水利巡检、工地进度巡查、DJI Dock / Cloud API 机巢无人值守调度、QGC / 地面站辅助调度、应急巡查辅助。
- 适合岗位：无人机系统集成工程师、无人机技术支持、地面站测试工程师、低空经济项目实施、AI 应用工程师-无人机方向。
- 短板边界：QGC/Qt 和深层 C++ 仍需要继续补；项目目前是仿真 MVP，不要说已经商用落地。
`.trim();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeConversationId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("resp_")) return "";
  return trimmed;
}

function buildPrompt(message) {
  return `${siteContext}

请用中文回答访客问题。回答要真诚、克制、清楚，不要夸大。

访客问题：
${message}`;
}

async function cozeFetch(path, token, options = {}) {
  const response = await fetch(`${COZE_API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
    const message = data.msg || data.message || data.error || "Coze API request failed.";
    throw new Error(`${message} (${response.status})`);
  }

  return data;
}

function pickAnswer(messages, chatId) {
  const list = Array.isArray(messages) ? messages : [];
  const answer = [...list]
    .reverse()
    .find((item) => {
      const isAnswer = item.role === "assistant" && item.type === "answer" && item.content;
      return isAnswer && (!item.chat_id || item.chat_id === chatId);
    });
  return answer?.content || "";
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Only POST requests are supported." }, 405);
  }

  const token = process.env.COZE_API_TOKEN;
  const botId = process.env.COZE_BOT_ID;

  if (!token || !botId) {
    return json({
      error: "Coze is not configured.",
      detail: {
        has_token: Boolean(token),
        has_bot_id: Boolean(botId)
      }
    }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const message = String(body?.message || "").trim();
  if (!message) {
    return json({ error: "Message is required." }, 400);
  }

  try {
    const payload = {
      bot_id: botId,
      user_id: body.user_id || "liuhai-site-visitor",
      stream: false,
      auto_save_history: true,
      additional_messages: [
        {
          role: "user",
          content: buildPrompt(message),
          content_type: "text"
        }
      ]
    };

    const conversationIdFromClient = safeConversationId(body.conversation_id);
    if (conversationIdFromClient) {
      payload.conversation_id = conversationIdFromClient;
    }

    const chatData = await cozeFetch("/v3/chat", token, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    const chatId = chatData.data?.id;
    const conversationId = chatData.data?.conversation_id;
    if (!chatId || !conversationId) {
      return json({ error: "Coze did not return chat_id or conversation_id.", detail: chatData }, 502);
    }

    let status = chatData.data?.status || "";
    for (let i = 0; i < MAX_POLLS; i += 1) {
      if (status === "completed") break;
      if (["failed", "canceled", "requires_action"].includes(status)) {
        return json({ error: `Coze chat ended with status: ${status}.` }, 502);
      }

      await sleep(POLL_INTERVAL_MS);
      const query = new URLSearchParams({
        chat_id: chatId,
        conversation_id: conversationId
      });
      const retrieveData = await cozeFetch(`/v3/chat/retrieve?${query}`, token);
      status = retrieveData.data?.status || status;
    }

    const messageQuery = new URLSearchParams({
      chat_id: chatId,
      conversation_id: conversationId
    });
    const messageData = await cozeFetch(`/v3/chat/message/list?${messageQuery}`, token);
    const answer = pickAnswer(messageData.data, chatId);

    if (!answer) {
      return json({
        error: "Coze completed but no answer message was found.",
        detail: { status, chat_id: chatId, conversation_id: conversationId }
      }, 504);
    }

    return json({
      answer,
      conversation_id: conversationId,
      provider: "coze"
    });
  } catch (error) {
    return json({
      error: "Coze request failed.",
      detail: error.message
    }, 500);
  }
}
