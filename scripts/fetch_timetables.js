// Yahoo!路線情報から JR京都線 京都・米原方面 の駅時刻表を取得し、
// index.html の *_TIMETABLE 定数を差し替える。
// GitHub Actions(.github/workflows/update-timetables.yml)から定期実行される。
//
// 使い方:
//   node fetch_timetables.js <html> [--apply] [--no-backup]
//   --apply なし: 取得して既存データとの差分を表示するだけ(timetables.json に保存)
//   --apply あり: バックアップを作ってから HTML のデータ行を書き換える
//   --no-backup : バックアップを作らない(Gitが履歴を持つGitHub Actions用)
//   本数の激減や未知の行き先があれば、書き換えずにエラー終了する
const fs = require("fs");
const path = require("path");

const STATIONS = [
  { name: "摂津富田", constName: "TONDA_TIMETABLE" },
  { name: "高槻", constName: "TAKATSUKI_TIMETABLE" },
  { name: "島本", constName: "SHIMAMOTO_TIMETABLE" },
  { name: "山崎", constName: "YAMAZAKI_TIMETABLE", searchName: "山崎(京都府)" },
  { name: "長岡京", constName: "NAGAOKAKYO_TIMETABLE" },
  { name: "向日町", constName: "MUKOMACHI_TIMETABLE" },
  { name: "桂川", constName: "KATSURAGAWA_TIMETABLE", searchName: "桂川(京都府)" },
];
const KINDS = { weekday: 1, saturday: 2, sunday: 4 };
const BASE = "https://transit.yahoo.co.jp";
const DELAY_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url){
  await sleep(DELAY_MS);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (research prototype timetable fetch)" } });
  if(!res.ok) throw new Error(`${res.status} ${url}`);
  lastUrl = res.url;
  return res.text();
}
let lastUrl = "";
const decode = s => s.replace(/&amp;/g, "&").replace(/<!-- -->/g, "");

async function findStationId(st){
  const q = st.searchName || st.name;
  const html = await get(`${BASE}/station/search?q=${encodeURIComponent(q)}`);
  // 候補が1駅だけのときは駅ページへ直接リダイレクトされる
  const direct = lastUrl.match(/\/station\/(\d+)/);
  if(direct) return direct[1];
  const links = [...html.matchAll(/href="\/station\/(\d+)">([^<]+)</g)];
  const hit = links.find(m => m[2] === q) || links.find(m => m[2] === st.name);
  if(!hit) throw new Error(`駅が見つからない: ${q} (候補: ${links.map(m => m[2]).join(", ")})`);
  return hit[1];
}

async function findKyotoBoundPath(stationId){
  const html = decode(await get(`${BASE}/station/time/${stationId}/`));
  // ＪＲ京都線 の「京都・米原方面」リンク
  const block = html.split("<dt>ＪＲ京都線</dt>")[1];
  if(!block) throw new Error(`ＪＲ京都線が無い: station ${stationId}`);
  // 駅によって「京都・米原方面」「高槻・京都方面」など表記が違うので「京都」を含む方面を探す
  const m = block.split("</dl>")[0].match(/<a href="(\/timetable\/\d+\/\d+)[^"]*">[^<]*京都[^<]*方面/);
  if(!m) throw new Error(`京都・米原方面が無い: station ${stationId}`);
  return m[1];
}

// ページに埋め込まれた __NEXT_DATA__ の JSON から読む(HTML表は始発などを取りこぼすため)。
// 特急は別料金が要るので除外する。
function parseTimetable(html){
  const raw = (html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/) || [])[1];
  if(!raw) throw new Error("__NEXT_DATA__ が無い");
  const item = JSON.parse(raw).props.pageProps.timetableItem;
  const kinds = Object.fromEntries(item.master.kind.map(k => [k.id, k.name]));
  const dests = Object.fromEntries(item.master.destination.map(d => [d.id, d.name.replace(/\(.*\)$/, "")]));
  const out = [];
  for(const h of item.hourTimeTable){
    // Yahooは深夜を 24時台 と表記するが、既存データは 0時台 表記
    const hh = String(Number(h.hour) % 24);
    for(const t of h.minTimeTable){
      if(kinds[t.kindId] === "特急") continue;
      const dest = dests[t.destinationId];
      if(!dest) throw new Error(`行き先IDが不明: ${t.destinationId}`);
      out.push([`${hh}:${t.minute.padStart(2, "0")}`, `${dest}行`]);
    }
  }
  if(out.length === 0) throw new Error("時刻が1件も取れない");
  return out;
}

function readExisting(html, constName){
  const m = html.match(new RegExp(`const ${constName} = (\\{.*\\});`));
  return m ? JSON.parse(m[1]) : null;
}

function diff(oldList, newList){
  const key = e => e.join(" ");
  const count = list => list.reduce((acc, e) => acc.set(key(e), (acc.get(key(e)) || 0) + 1), new Map());
  const a = count(oldList || []), b = count(newList);
  const removed = [], added = [];
  for(const [k, n] of a) for(let i = (b.get(k) || 0); i < n; i++) removed.push(k);
  for(const [k, n] of b) for(let i = (a.get(k) || 0); i < n; i++) added.push(k);
  return { removed, added };
}

(async () => {
  const htmlPath = process.argv[2];
  const apply = process.argv.includes("--apply");
  if(!htmlPath) throw new Error("HTMLファイルのパスを指定してください");
  let html = fs.readFileSync(htmlPath, "utf8");

  const result = {};
  for(const st of STATIONS){
    const id = await findStationId(st);
    const ttPath = await findKyotoBoundPath(id);
    result[st.name] = {};
    for(const [day, kind] of Object.entries(KINDS)){
      result[st.name][day] = parseTimetable(await get(`${BASE}${ttPath}?kind=${kind}`));
    }
    const old = readExisting(html, st.constName);
    console.log(`\n== ${st.name} (station ${id}, ${ttPath})`);
    for(const day of Object.keys(KINDS)){
      const { removed, added } = diff(old && old[day], result[st.name][day]);
      console.log(`  ${day}: ${result[st.name][day].length}本 (既存 ${old ? old[day].length : "-"}本)` +
        (removed.length ? `\n    削除: ${removed.join(", ")}` : "") +
        (added.length ? `\n    追加: ${added.join(", ")}` : ""));
    }
  }

  const outJson = path.join(__dirname, "timetables.json");
  fs.writeFileSync(outJson, JSON.stringify(result, null, 1));
  console.log(`\n保存: ${outJson}`);

  // 安全策: おかしなデータでページを壊さないよう、怪しければ書き換えずに止める
  const known = new Set([...html.matchAll(/\{ name: "([^"]+)", min: \d+ \}/g)].map(m => m[1]));
  const problems = [];
  for(const st of STATIONS){
    const old = readExisting(html, st.constName);
    for(const day of Object.keys(KINDS)){
      const list = result[st.name][day];
      // 本数が既存の8割未満に減った = 取得ミスの可能性が高い
      if(old && list.length < old[day].length * 0.8){
        problems.push(`${st.name} ${day}: ${old[day].length}本 → ${list.length}本 に激減`);
      }
      // LINE_STATIONS に無い行き先の電車は計算で無視されてしまう
      for(const [time, dest] of list){
        if(!known.has(dest.replace("行", ""))) problems.push(`${st.name} ${day} ${time}: 未知の行き先「${dest}」(LINE_STATIONSに追加が必要)`);
      }
    }
  }
  if(problems.length){
    throw new Error("書き換えを中止しました:\n  " + problems.join("\n  "));
  }

  if(apply){
    const noBackup = process.argv.includes("--no-backup");
    const backup = htmlPath.replace(/\.html$/, `.backup-${new Date().toISOString().slice(0, 10)}.html`);
    if(!noBackup) fs.copyFileSync(htmlPath, backup);
    for(const st of STATIONS){
      const re = new RegExp(`const ${st.constName} = \\{.*\\};`);
      if(!re.test(html)) throw new Error(`${st.constName} がHTML内に無い`);
      html = html.replace(re, () => `const ${st.constName} = ${JSON.stringify(result[st.name]).replace(/,/g, ", ").replace(/:/g, ": ").replace(/"(\d+): (\d+)"/g, '"$1:$2"')};`);
    }
    fs.writeFileSync(htmlPath, html);
    console.log(`書き換え完了: ${htmlPath}` + (noBackup ? "" : `\nバックアップ: ${backup}`));
  }
})().catch(e => { console.error("エラー:", e.message); process.exit(1); });
