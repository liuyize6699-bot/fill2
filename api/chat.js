export const config = { runtime: "edge" };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const siteAssistantPrompt = `
你是刘海个人网站上的 AI 项目助手。你的任务是帮访客快速了解刘海的经历、项目和岗位匹配。

刘海背景：
- AI 原生全栈开发者，CAAC 无人机机长执照持有者。
- 上一份工作：福华创新无人机有限公司，无人机技术员，2025.08-2026.02。
- 本科：华南师范大学，环境艺术设计。
- 有大疆 M300/M210 外场经验，做过无人机技术支持、方案表达、客户培训与现场交付。

核心项目：
- 大模型驱动的无人机集群自动化调度系统。
- 链路：飞书消息 -> Coze/Agent 解析 -> 地图/天气 API -> FastAPI 云端服务 -> 本地 listener 轮询 -> MAVSDK/MAVLink 控制 PX4 -> AirSim 控制 UE4 虚拟飞机 -> Gazebo + UE4 双仿真验证。
- PX4 二次开发：自定义 DroneTaskStatus 消息，自定义 drone_task_manager 模块，继承 ScheduledWorkItem，1Hz 广播任务状态，完成 Kconfig、CMakeLists、编译和 pxh 控制台验证。

真实落地场景：
- 园区/厂区日常巡逻：固定航线、固定频次、固定检查点，减少每次都依赖专业飞手。
- 光伏/电力/水利巡检：任务解析、航线生成、天气判断、图像采集和飞后报告闭环。
- 工地/园区进度巡查：按周或按天采集俯视影像和关键点位照片，做进度和现场管理记录。
- 机巢无人值守调度：未来接 DJI Dock / Cloud API，作为任务中枢接收任务、检查条件、下发航线、接收状态。
- 地面站/QGC 辅助调度：中文任务到航线草案、任务状态显示、MAVLink 日志解析。
- 应急巡查辅助：AI 帮忙整理任务和点位，但最终执行保留人工确认和安全接管。

真实能力：
- MAVLink v2、MAVSDK-Python、PX4 SITL、Gazebo、AirSim、FastAPI、asyncio、Coze/Dify Agent、Function Calling、方案表达、设计可视化。
- 代码主要通过 AI 辅助生成，刘海负责方案设计、实施验证、理解调试和链路打通。

岗位方向：
- 适合：无人机系统集成工程师、无人机技术支持、地面站测试工程师、低空经济项目实施、AI 应用工程师-无人机方向。
- 可培养：QGC 二次开发、Qt/QML、DJI Cloud API / Dock 平台接入、飞行日志分析、巡检报告自动化。
- 暂时不硬冲：纯飞控算法研发、强 C++ 底层架构、视觉 SLAM/路径规划算法岗。

回答要求：
- 使用中文，像刘海本人网站上的助手一样真诚、克制、清楚。
- 不要夸大，不要说项目已经商用落地。
- 如果访客问招聘匹配，要强调外场 + MAVLink/PX4 仿真 + AI 工作流集成。
- 如果访客问短板，要诚实说明 QGC/Qt 和深层 C++ 需要继续补。
`.trim();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders
    }
  });
}

function extractOpenAIText(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function callOpenAI(body) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-5.4-mini";
  const previousResponseId = String(body.conversation_id || "").startsWith("resp_")
    ? body.conversation_id
    : undefined;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      instructions: siteAssistantPrompt,
      input: body.message,
      previous_response_id: previousResponseId
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return json({ error: "OpenAI request failed.", detail: data }, response.status);
  }

  return json({
    answer: extractOpenAIText(data) || "我暂时没有组织好回答，可以换个问法再试一次。",
    conversation_id: data.id
  });
}

async function callCoze(body) {
  const token = process.env.COZE_API_TOKEN;
  const botId = process.env.COZE_BOT_ID || "7622600974024704040";

  const chatRes = await fetch("https://api.coze.cn/v3/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      bot_id: botId,
      user_id: body.user_id || "visitor",
      stream: false,
      auto_save_history: true,
      conversation_id: body.conversation_id || undefined,
      additional_messages: [
        {
          role: "user",
          content: body.message,
          content_type: "text"
        }
      ]
    })
  });

  const chatData = await chatRes.json();
  if (!chatRes.ok || !chatData.data?.id) {
    return json({ error: "Coze chat init failed.", detail: chatData }, 500);
  }

  const chatId = chatData.data.id;
  const conversationId = chatData.data.conversation_id;
  let answer = "";

  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const msgRes = await fetch(
      `https://api.coze.cn/v3/chat/message/list?chat_id=${chatId}&conversation_id=${conversationId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const msgData = await msgRes.json();
    const found = msgData.data?.find((msg) => msg.role === "assistant" && msg.type === "answer");
    if (found?.content) {
      answer = found.content;
      break;
    }
  }

  return json({
    answer: answer || "响应超时，请稍后再试。",
    conversation_id: conversationId
  });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Only POST requests are supported." }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  if (!body?.message) {
    return json({ error: "Message is required." }, 400);
  }

  if (process.env.OPENAI_API_KEY) {
    return callOpenAI(body);
  }

  if (process.env.COZE_API_TOKEN) {
    return callCoze(body);
  }

  return json({
    error: "No AI provider is configured. Set OPENAI_API_KEY or COZE_API_TOKEN."
  }, 500);
}
