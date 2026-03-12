const { Client } = require('@notionhq/client');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_INPUT_ID = process.env.DB_INPUT_ID;
const GROQ_KEY = process.env.GROQ_API_KEY; 
const DB_ACADEMIC_ID = process.env.DB_ACADEMIC_EVENT_ID; 
const DB_ACTION_ID = process.env.DB_ACTION_ID; 

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
});

async function main() {
  try {
    console.log("=== 1. ニュース・技術情報の収集 (Zenn統合・画像強化版) ===");
    await fetchNewsDaily();
    console.log("\n=== 2. 自動お掃除 (作成から7日経過) ===");
    await autoCleanupTrash();
    console.log("\n=== 3. 学術大会情報 ===");
    if (DB_ACADEMIC_ID) await fetchAllConferences();
    console.log("\n=== 4. PubMed要約 ===");
    await fillPubmedDataWithAI();
    console.log("\n=== 5. 専門的な『問い』を自律生成 ===");
    if (DB_ACTION_ID) await generateAutonomousQuestions();

    console.log("\n✨ すべての処理が正常に完了しました");
  } catch (e) { console.error("メイン実行エラー:", e.message); }
}

async function fetchNewsDaily() {
  const sources = [
    { name: "ICT教育ニュース", url: "https://ict-enews.net/feed/" },
    { name: "ITmedia AI+", url: "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml" },
    { name: "テクノエッジ", url: "https://www.techno-edge.net/rss20/index.rdf" },
    { name: "Zenn", url: "https://zenn.dev/feed" } 
  ];
  
  const keywords = ["AI", "Notion", "Gemini", "効率化", "自動化", "IT", "ChatGPT", "生成AI", "理学療法", "GitHub", "Python"];
  
  for (const source of sources) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of feed.items.slice(0, 5)) {
        const title = item.title.replace(/[\[【].*?[\]】]/g, '').trim();
        if (keywords.some(kw => title.toUpperCase().includes(kw.toUpperCase()))) {
          const exists = await notion.databases.query({ 
            database_id: DB_INPUT_ID, 
            filter: { property: "名前", title: { equals: title } } 
          });
          
          if (exists.results.length === 0) {
            const imageUrl = await getImageUrl(item);
            await createNotionPage(title, item.link, imageUrl, source.name);
            console.log(`✅ 登録: ${title} (${source.name})`);
          }
        }
      }
    } catch (e) { 
      console.error(`❌ ${source.name}収集エラー: ${e.message}`); 
    }
  }
}

async function getImageUrl(item) {
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  
  try {
    const res = await axios.get(item.link, { 
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      }, 
      timeout: 8000 
    });
    const $ = cheerio.load(res.data);
    
    return $('meta[property="og:image"]').attr('content') || 
           $('meta[name="twitter:image"]').attr('content') || 
           null;
  } catch (e) { 
    return null; 
  }
}

async function autoCleanupTrash() {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - 7);
  try {
    const res = await notion.databases.query({
      database_id: DB_INPUT_ID,
      filter: {
        and: [
          { property: '削除チェック', checkbox: { equals: true } },
          { property: '作成日時', date: { on_or_before: thresholdDate.toISOString() } }
        ]
      }
    });
    for (const page of res.results) {
      await notion.pages.update({ page_id: page.id, archived: true });
      console.log(`🗑️ アーカイブ完了: ${page.id}`);
    }
  } catch (e) { console.error("お掃除エラー:", e.message); }
}

async function createNotionPage(title, link, imageUrl, sourceName) {
  const children = imageUrl ? [{ object: "block", type: "image", image: { type: "external", external: { url: imageUrl } } }] : [];
  children.push({ object: "block", type: "bookmark", bookmark: { url: link } });
  await notion.pages.create({
    parent: { database_id: DB_INPUT_ID },
    cover: imageUrl ? { type: "external", external: { url: imageUrl } } : null,
    properties: { 
      '名前': { title: [{ text: { content: title } }] }, 
      'URL': { url: link }, 
      '情報源': { select: { name: sourceName } } 
    },
    children: children
  });
}

async function formatDateWithAI(dateText) {
  try {
    const prompt = `学会日程を解析しJSON生成。形式YYYY-MM-DD。\n【日程】: ${dateText}\n【出力形式】: { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" or null }`;
    const aiRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    }, { headers: { "Authorization": `Bearer ${GROQ_KEY.trim()}`, "Content-Type": "application/json" } });
    return JSON.parse(aiRes.data.choices[0].message.content);
  } catch (e) { return null; }
}

async function fetchAllConferences() {
  try {
    const res = await axios.get("https://www.jspt.or.jp/conference/", { headers: { "User-Agent": "Mozilla/5.0" } });
    const $ = cheerio.load(res.data);
    const rows = $('table tbody tr').get();
    for (const row of rows) {
      const cells = $(row).find('td');
      if (cells.length >= 5) {
        const confName = $(cells[1]).text().trim();
        const link = $(cells[1]).find('a').attr('href');
        if (link && link.startsWith('http')) {
          const exists = await notion.databases.query({ database_id: DB_ACADEMIC_ID, filter: { property: "URL", url: { equals: link } } });
          if (exists.results.length === 0) {
            const dateObj = await formatDateWithAI($(cells[2]).text().trim());
            await notion.pages.create({
              parent: { database_id: DB_ACADEMIC_ID },
              properties: {
                '大会名称': { title: [{ text: { content: confName } }] },
                'URL': { url: link },
                '開催年月日': { date: dateObj },
                '会場': { rich_text: [{ text: { content: $(cells[3]).text().trim() } }] },
                '備考': { rich_text: [{ text: { content: $(cells[4]).text().trim() } }] }
              }
            });
            console.log(`✅ 大会登録: ${confName}`);
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      }
    }
  } catch (e) { console.error("学術大会エラー:", e.message); }
}

async function generateAutonomousQuestions() {
  try {
    const prompt = `理学療法士教員の視点で「本質的な問い」を3つJSON生成。形式: { "actions": [ { "q": "文章" } ] }`;
    const aiRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    }, { headers: { "Authorization": `Bearer ${GROQ_KEY.trim()}`, "Content-Type": "application/json" } });
    const aiData = JSON.parse(aiRes.data.choices[0].message.content);
    for (const item of aiData.actions) {
      const exists = await notion.databases.query({ database_id: DB_ACTION_ID, filter: { property: "問い", title: { equals: item.q } } });
      if (exists.results.length === 0) {
        await notion.pages.create({
          parent: { database_id: DB_ACTION_ID },
          properties: { '問い': { title: [{ text: { content: item.q } }] }, 'GTD': { status: { name: "Inbox" } } }
        });
        console.log(`✅ 問い登録: ${item.q}`);
      }
    }
  } catch (e) { console.error("問い生成エラー:", e.message); }
}

async function fillPubmedDataWithAI() {
  const res = await notion.databases.query({
    database_id: DB_INPUT_ID,
    filter: { and: [{ property: "URL", url: { contains: "pubmed.ncbi.nlm.nih.gov" } }, { property: "タイトル和訳", rich_text: { is_empty: true } }] }
  });
  for (const page of res.results) {
    const url = page.properties.URL.url;
    try {
      const response = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 });
      const $ = cheerio.load(response.data);
      const title = $('h1.heading-title').text().trim();
      const abstract = $('.abstract-content').text().trim().substring(0, 1500);
      await new Promise(r => setTimeout(r, 20000));
      const aiRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: `翻訳・要約せよ。JSON形式。{translatedTitle, summary}\nTitle: ${title}\nAbstract: ${abstract}` }],
        response_format: { type: "json_object" }
      }, { headers: { "Authorization": `Bearer ${GROQ_KEY.trim()}`, "Content-Type": "application/json" } });
      const aiData = JSON.parse(aiRes.data.choices[0].message.content);
      await notion.pages.update({
        page_id: page.id,
        properties: {
          "タイトル和訳": { rich_text: [{ text: { content: aiData.translatedTitle } }] },
          "要約": { rich_text: [{ text: { content: aiData.summary } }] }
        }
      });
      console.log(`✅ PubMed要約完了: ${aiData.translatedTitle}`);
    } catch (e) { console.error(`❌ PubMedエラー: ${e.message}`); }
  }
}

main();
