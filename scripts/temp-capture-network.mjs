import { chromium } from "playwright";

const urls = [
  "https://outputbio.com/jobs?ashby_jid=da2723ca-a418-49f1-b7da-a4f383dd8239&utm_source=9Bnp64Dlm3",
  "https://picknik.ai/careers/?ashby_jid=24b6b42a-717c-46c6-afcf-3ddcdccd0fdd&utm_source=xVenzjMWk1",
  "https://odindynamics.ai/careers?ashby_jid=9b30430d-86e4-4c3f-93d8-f06de09b1f61&utm_source=5YP7JgLEwz",
  "https://www.golinks.io/careers.php?ashby_jid=a744b69b-2ef9-4865-ab80-2f68a3815d7e&src=linkedin",
  "https://www.golinks.io/careers.php?ashby_jid=441bb00f-cda4-41bb-8ec1-7e56db28f25f&src=linkedin",
  "https://www.higharc.com/company/careers?ashby_jid=5a7265ed-8db3-480e-9c04-3c9b2d2c235b&utm_source=QZKW5dVRY5",
  "https://www.sandboxaq.com/careers-list?ashby_jid=3189f622-cd7c-4ddb-b4e4-494a5f75bf84&utm_source=LinkedInPaid",
  "https://www.skydio.com/careers?ashby_jid=00881c96-cfbe-4716-80e8-947904b40c28&utm_source=jobright",
  "https://www.skydio.com/careers?ashby_jid=8d3979a8-c791-4825-8cf4-9b25479b9519&utm_source=jobright",
  "https://www.skydio.com/careers?ashby_jid=b90b9b3b-e326-4fb6-85bd-fe52bec5f180&utm_source=LinkedInPaid",
  "https://www.conductorone.com/careers?ashby_jid=db5ebd0c-669f-45b9-8709-cf507f9b7b1f&utm_source=kZYoe4v1l3",
  "https://www.skydio.com/careers?ashby_jid=c84945f0-b8e0-4272-b636-265d6611a8eb&utm_source=LinkedInPaid",
  "https://www.skydio.com/careers?ashby_jid=17f6173b-c96f-4b02-a6b5-da0a91ad95e5&utm_source=LinkedInPaid",
  "https://dryft.ai/careers?ashby_jid=3f1c261d-9b65-412b-9f17-34b8968bdd78&utm_source=neYwgLxvAb",
  "https://www.monogram.ai/hiring?ashby_jid=266ea87b-24b5-4b0d-be57-57eb4bc69df7&utm_source=LinkedIn",
  "https://www.monogram.ai/hiring?ashby_jid=fab3e651-00e7-4a85-bcb9-0821c642a778&utm_source=LinkedIn",
  "https://virtueai.webflow.io/virtue-ai-career?ashby_jid=e780a243-7563-431d-b458-1c6687c20bcf&utm_source=JbGV5ZqYMk"
];

function getAshbyJobId(pageUrl) {
  try {
    return new URL(pageUrl).searchParams.get("ashby_jid");
  } catch {
    return null;
  }
}

async function captureAshbyRequests(browser, pageUrl) {
  const page = await browser.newPage();
  const jobId = getAshbyJobId(pageUrl);
  const matchedRequests = [];
  const seen = new Set();

  if (!jobId) {
    await page.close();
    return { pageUrl, jobId: null, requests: [] };
  }

  page.on("request", (request) => {
    const reqUrl = request.url();
    const method = request.method();
    const postData = request.postData() || "";

    const isAshbyDomain = reqUrl.includes("jobs.ashbyhq.com");
    const hasJobId =
      reqUrl.includes(jobId) ||
      reqUrl.includes(`ashby_jid=${jobId}`) ||
      postData.includes(jobId);

    if (method === "GET" && isAshbyDomain && hasJobId && !seen.has(reqUrl)) {
      seen.add(reqUrl);
      matchedRequests.push({
        url: reqUrl,
        method,
        resourceType: request.resourceType(),
      });
    }
  });

  try {
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(5000);

    return {
      pageUrl,
      jobId,
      requests: matchedRequests,
    };
  } catch (error) {
    return {
      pageUrl,
      jobId,
      requests: [],
      error: error.message,
    };
  } finally {
    await page.close();
  }
}

async function captureAllAshbyRequests(urls) {
  const browser = await chromium.launch({ headless: true });

  try {
    const results = await Promise.all(
      urls.map((url) => captureAshbyRequests(browser, url))
    );

    return results;
  } finally {
    await browser.close();
  }
}

captureAllAshbyRequests(urls).then((results) => {
  console.log(JSON.stringify(results, null, 2));
});