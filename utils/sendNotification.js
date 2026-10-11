
const APP_ID = process.env.ONESIGNAL_APP_ID;
const API_KEY = process.env.ONESIGNAL_REST_API_KEY;

export async function sendNotification({
  title,
  publisher,
  group = "All",
  category = "Notice",
  description = "",
}) {
  if (!APP_ID || !API_KEY) {
    throw new Error("OneSignal App ID/API Key missing");
  }

  const heading = `${category} • Posted by ${publisher}`;
  const content = `[${group}] ${title}${
    description ? ` — ${description}` : ""
  }`;

  const response = await fetch(
    "https://api.onesignal.com/notifications",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${API_KEY}`,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        included_segments: ["Subscribed Users"],
        headings: { en: heading },
        contents: { en: content },
        url: "https://cst-hub.vercel.app",
        data: {
          publisher,
          group,
          category,
          title,
        },
      }),
    }
  );

  const result = await response.json();

  if (!response.ok) {
    console.error("OneSignal failed:", result);
    throw new Error("Notification send failed");
  }

  console.log("Notification sent:", {
    title,
    publisher,
    group,
    category,
    recipients: result.recipients,
    notificationId: result.id,
  });

  return result;
}
