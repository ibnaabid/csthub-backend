
const APP_ID = process.env.ONESIGNAL_APP_ID;
const API_KEY = process.env.ONESIGNAL_REST_API_KEY;

async function sendNotification({
  title,
  publisher,
  group = "All",
  category = "Notice",
  description = "",
}) {
  if (!APP_ID || !API_KEY) {
    throw new Error("OneSignal App ID or REST API Key missing");
  }

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
        headings: {
          en: `${category} • Posted by ${publisher}`,
        },
        contents: {
          en: `[${group}] ${title}${
            description ? ` — ${description}` : ""
          }`,
        },
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

  console.log("OneSignal response:", result);

  if (!response.ok || result.errors) {
    throw new Error(
      `OneSignal failed: ${JSON.stringify(result.errors || result)}`
    );
  }

  return result;
}

module.exports = { sendNotification };
