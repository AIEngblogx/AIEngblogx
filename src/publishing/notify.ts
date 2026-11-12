import { appendLog, messageOf } from "../shared/log.ts";

export interface NotificationPayload {
  title: string;
  url: string;
  original_url: string;
  date: string;
}

export async function sendNotification(root: string, payload: NotificationPayload): Promise<void> {
  const endpoint = process.env.BLOG_WEBHOOK_URL;
  if (endpoint === undefined || endpoint === "") return;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: `New article: ${payload.title}`,
        url: payload.url,
        original_url: payload.original_url,
        date: payload.date,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`http ${response.status} from webhook`);
  } catch (error) {
    await appendLog(root, "notify", { event: "webhook_failed", error: messageOf(error) });
  }
}
