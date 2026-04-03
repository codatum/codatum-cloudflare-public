/**
 * Cloudflare Worker: Slack Events API handler
 *
 * Slack の app_mention イベントを受信し:
 * 1. 簡単な質問 → Claude API で直接回答して Slack に返信（数秒）
 * 2. 調査が必要 → 「調べますね」と返信 → GitHub Actions をトリガー
 *
 * 静的アセット配信も引き続きサポート。
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/slack/events" && request.method === "POST") {
      return handleSlackEvent(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleSlackEvent(request, env, ctx) {
  const body = await request.text();
  const payload = JSON.parse(body);

  if (payload.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const isValid = await verifySlackSignature(request, body, env.SLACK_SIGNING_SECRET);
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  if (request.headers.get("X-Slack-Retry-Num")) {
    return new Response("OK", { status: 200 });
  }

  if (payload.type !== "event_callback") {
    return new Response("OK", { status: 200 });
  }

  const event = payload.event;

  if (event.type !== "app_mention" || event.bot_id) {
    return new Response("OK", { status: 200 });
  }

  ctx.waitUntil(processMessage(event, env));

  return new Response("OK", { status: 200 });
}

/**
 * メッセージを処理する。Claude API で判定し、直接回答 or GitHub Actions にフォールバック。
 */
async function processMessage(event, env) {
  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const textWithContext = await buildTextWithContext(event, env.SLACK_BOT_TOKEN);

  try {
    await addReaction(channel, event.ts, env.SLACK_BOT_TOKEN);

    // Claude API で回答を試みる（スレッド履歴込み）
    const result = await askClaude(textWithContext, env.ANTHROPIC_API_KEY);

    if (result.needsInvestigation) {
      // 調査が必要 → 一言返してから GitHub Actions をトリガー
      await postSlackMessage(channel, threadTs, result.quickReply, env.SLACK_BOT_TOKEN);
      await triggerWorkflow(event, env);
    } else {
      // 直接回答
      await postSlackMessage(channel, threadTs, result.answer, env.SLACK_BOT_TOKEN);
    }
  } catch (err) {
    console.error("processMessage error:", err);
    await postSlackMessage(channel, threadTs, `エラーが発生しました: ${err.message}`, env.SLACK_BOT_TOKEN);
  }
}

/**
 * Claude API を呼び出して回答を生成する。
 * 調査が必要かどうかも判定する。
 */
async function askClaude(userText, apiKey) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-20250514",
      max_tokens: 1024,
      system: `あなたは codatum 社の AI アシスタント「こだたむ」です。Slack で同僚からメンションされました。

トーン: カジュアルに、シンプルに。同僚とチャットしている感覚で。長文禁止。

回答方法:
- 一般的な知識で答えられる質問 → そのまま短く回答
- 社内システムの調査、API呼び出し、コード調査、ログ確認などが必要 → 調査が必要と判定

回答は必ず以下の JSON 形式で返してください:
{
  "needsInvestigation": false,
  "answer": "直接回答する場合のテキスト",
  "quickReply": "調査が必要な場合の一言（例: '調べますね！少し待ってください'）"
}

needsInvestigation が true の場合は quickReply を、false の場合は answer を使います。`,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.content[0].text;

  try {
    // JSON をパース
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    // JSON パース失敗 → そのまま回答として返す
  }

  return { needsInvestigation: false, answer: content };
}

// --- Slack API helpers ---

async function addReaction(channel, timestamp, botToken) {
  await fetch("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, timestamp, name: "eyes" }),
  });
}

async function postSlackMessage(channel, threadTs, text, botToken) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
}

// --- Slack signature verification ---

async function verifySlackSignature(request, body, signingSecret) {
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const signature = request.headers.get("X-Slack-Signature");

  if (!timestamp || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sigBasestring));
  const hexSig =
    "v0=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  return hexSig === signature;
}

// --- Thread context ---

/**
 * スレッド内のメンションの場合、スレッド全体の会話を取得してテキストにまとめる。
 * チャンネル直投稿の場合はメンションメッセージのみ返す。
 */
async function buildTextWithContext(event, botToken) {
  // スレッド内でない場合はそのまま返す
  if (!event.thread_ts) {
    return event.text;
  }

  try {
    const resp = await fetch(
      `https://slack.com/api/conversations.replies?channel=${event.channel}&ts=${event.thread_ts}&limit=50`,
      {
        headers: { Authorization: `Bearer ${botToken}` },
      }
    );
    const data = await resp.json();
    if (!data.ok || !data.messages || data.messages.length <= 1) {
      return event.text;
    }

    // メンションメッセージ自身を除いたスレッドの会話を整形
    // text が空の場合は attachments の fallback/text を使う（Datadog等のbot投稿対策）
    const context = data.messages
      .filter((m) => m.ts !== event.ts)
      .map((m) => {
        if (m.text) return m.text;
        if (m.attachments && m.attachments.length > 0) {
          const att = m.attachments[0];
          return [att.title, att.text, att.fallback].filter(Boolean).join("\n");
        }
        return "";
      })
      .filter((t) => t)
      .join("\n---\n");

    return `以下はスレッドのこれまでの会話です:\n${context}\n\n---\n最新のメンション:\n${event.text}`;
  } catch (err) {
    console.error("Failed to fetch thread context:", err);
    return event.text;
  }
}

// --- GitHub Actions trigger ---

async function triggerWorkflow(event, env) {
  const [textWithContext, channelName, userName] = await Promise.all([
    buildTextWithContext(event, env.SLACK_BOT_TOKEN),
    fetchChannelName(event.channel, env.SLACK_BOT_TOKEN),
    fetchUserName(event.user, env.SLACK_BOT_TOKEN),
  ]);

  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/slack.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "kodatamu-worker",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          channel: event.channel,
          channel_name: channelName,
          thread_ts: event.thread_ts || event.ts,
          message_ts: event.ts,
          user: event.user,
          user_name: userName,
          text: textWithContext,
          trigger_text: event.text,
        },
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub Actions のトリガーに失敗しました (${response.status}): ${text}`);
  }
}

async function fetchChannelName(channelId, token) {
  try {
    const res = await fetch(`https://slack.com/api/conversations.info?channel=${channelId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.ok ? data.channel.name : "";
  } catch {
    return "";
  }
}

async function fetchUserName(userId, token) {
  try {
    const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.ok ? (data.user.profile.display_name || data.user.real_name || "") : "";
  } catch {
    return "";
  }
}
