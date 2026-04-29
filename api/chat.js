const COZE_API_BASE = "https://api.coze.cn";
const MAX_POLLS = 24;
const POLL_INTERVAL_MS = 800;

const siteContext = `
刘海个人网站资料：
- 刘海，AI原生全栈开发者，CAAC无人机机长执照持有者。
- 上一份工作：福华创新无人机有限公司，无人机技术员，2025.08-2026.02。
- 本科：华南师范大学，环境艺术设计。
- 有大疆M300/M210外场经验，做过无人机技术支持、方案表达、客户培训与现场交付。
- 核心项目：大模型驱动的无人机集群自动化调度系统。
- 项目链路：飞书消息->Coze/Agent解析->地图/天气API->FastAPI云端服务->本地listener轮询->MAVSDK/MAVLink控制PX4->AirSim控制UE4虚拟飞机->Gazebo+UE4双仿真验证。
- PX4二次开发：自定义DroneTaskStatus消息，自定义drone_task_manager模块，继承ScheduledWorkItem，1Hz广播任务状态。
- 适合岗位：无人机系统集成工程师、地面站测试工程师、AI应用工程师-无人机方向。
- 短板：QGC/Qt和深层C++仍需要继续补；项目目前是仿真MVP，未商用落地。
`.trim();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || (typeof data.code === "number" && data.code !== 0)) {
    throw new Error(`${data.msg || data.message || "Coze API failed"} (${response.status})`);
  }
  return data;
}

function pickAnswer(messages, chatId) {
  const list = Array.isArray(messages) ? messages : [];
  const answer = [...list].reverse().find((item) =>
    item.role === "assistant" && item.type === "answer" && item.content &&
    (!item.chat_id || item.chat_id === chatId)
  );
  return answer?.content || "";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST supported." });

  const token = process.env.COZE_API_TOKEN;
  const botId = process.env.COZE_BOT_ID;

  if (!token || !botId) {
    return res.status(500).json({
      error: "Coze not configured.",
      has_token: Boolean(token),
      has_bot_id: Boolean(botId)
    });
  }

  const body = req.body;
  const message = String(body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required." });

  try {
    const payload = {
      bot_id: botId,
      user_id: body.user_id || "liuhai-site-visitor",
      stream: false,
      auto_save_history: true,
      additional_messages: [{
        role: "user",
        content: `${siteContext}\n\n请用中文回答访客问题，真诚克制清楚，不要夸大。\n\n访客问题：${message}`,
        content_type: "text"
      }]
    };

    if (body.conversation_id && !String(body.conversation_id).startsWith("resp_")) {
      payload.conversation_id = body.conversation_id;
    }

    const chatData = await cozeFetch("/v3/chat", token, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    const chatId = chatData.data?.id;
    const conversationId = chatData.data?.conversation_id;
    if (!chatId || !conversationId) {
      return res.status(502).json({ error: "No chat_id returned.", detail: chatData });
    }

    let status = chatData.data?.status || "";
    for (let i = 0; i < MAX_POLLS; i++) {
      if (status === "completed") break;
      if (["failed", "canceled", "requires_action"].includes(status)) {
        return res.status(502).json({ error: `Chat ended with status: ${status}` });
      }
      await sleep(POLL_INTERVAL_MS);
      const q = new URLSearchParams({ chat_id: chatId, conversation_id: conversationId });
      const retrieve = await cozeFetch(`/v3/chat/retrieve?${q}`, token);
      status = retrieve.data?.status || status;
    }

    const q = new URLSearchParams({ chat_id: chatId, conversation_id: conversationId });
    const msgData = await cozeFetch(`/v3/chat/message/list?${q}`, token);
    const answer = pickAnswer(msgData.data, chatId);

    if (!answer) {
      return res.status(504).json({ error: "No answer found.", status, chat_id: chatId });
    }

    return res.status(200).json({ answer, conversation_id: conversationId });

  } catch (error) {
    return res.status(500).json({ error: "Coze request failed.", detail: error.message });
  }
}
