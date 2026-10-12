
const APP_ID = process.env.ONESIGNAL_APP_ID;
const API_KEY = process.env.KEY_ID;

async function sendNotification({
  title,
  publisher = "CST Hub",
  group = "All",
  category = "Notice",
  description = "",
}) {
  if (!APP_ID || !API_KEY) {
    throw new Error(
      "Missing ONESIGNAL_APP_ID or KEY_ID"
    );
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

  console.log("OneSignal HTTP status:", response.status);
  console.log("OneSignal response:", result);

  if (!response.ok || result.errors) {
    throw new Error(
      `OneSignal failed: ${JSON.stringify(result.errors || result)}`
    );
  }

  return result;
}

module.exports = { sendNotification };
