/**
 * 関連レポートをビルド時にローカル算出する。
 *
 * 以前は `[feature]/[...slug].astro` が 1 ページごとに D1 API
 * (`GET /api/reports/{id}/related`) を叩いていた。この API は `report_tags` の
 * 自己結合で、1 レポート平均 13.5 タグ × タグごとのファンアウト (最大 218) の分だけ
 * 行を読む — 実測で 1 リクエスト約 3,000 rows_read。レポートページは 861 枚あるため
 * **1 ビルドで最大 250 万 rows_read** に達し、D1 無料枠 (500 万 rows_read/日) を
 * 2〜3 デプロイで使い切っていた。
 *
 * 一方 `getAllReportTags()` は `/api/tags/bulk` を 1 回だけ叩いて全レポートの
 * タグを保持している。共有タグ数の計算に必要なデータはビルド開始時点で
 * すべてメモリ上にあるため、**D1 への追加アクセスなしで**関連レポートを出せる。
 *
 * スコアは IDF 重み付け (`ln(N / df)`)。全レポートの `GENERIC_TAG_RATIO` を超えて
 * 出現するタグは「関連性の signal にならない汎用タグ」として候補計算から除外する。
 *
 * **SSR (`prerender = false`) から呼ばないこと。** 内部で `getAllReports()` =
 * `getCollection()` を使うため、SSR で参照すると collection 全件が Worker bundle に
 * 埋め込まれてサイズ上限に当たる (`.claude/rules/cloudflare-astro-patterns.md` §20)。
 * 利用先は SSG ページのみ。
 */
import { features } from '../features';
import { getAllReports } from './all-reports';
import { getAllReportTags, getUnpublishedIds, toD1Id } from './d1-client';

/** 出現率がこの割合を超えるタグは汎用タグとみなし、関連度の計算から除外する */
const GENERIC_TAG_RATIO = 0.15;

export interface RelatedReport {
  /** D1 形式の ID (`<feature>/<date>[/<lang>]`) */
  report_id: string;
  /** ページ URL に使う Astro collection の slug (`2026-04-12ja` 等) */
  slug: string;
  feature: string;
  date: string;
  title: string;
  /** 共有した有意タグ (汎用タグを除外した後) */
  shared_tags: string[];
  shared_count: number;
}

interface ReportMeta {
  slug: string;
  feature: string;
  date: string;
  title: string;
}

// `getAllReports()` は動的な collection key を取るため `CollectionEntry` の
// union が `never` に潰れ、`.id` / `.data` の参照が ts(2339) になる
// (既存ページにも同じノイズが多数ある)。ここで必要な形だけを宣言して受け取り、
// 新規の型エラーを持ち込まないようにする。`as any` は使わない。
interface ReportEntryLike {
  id: string;
  data: { date: string; title: string };
}

interface RelatedIndex {
  meta: Map<string, ReportMeta>;
  /** レポート → 有意タグ */
  tagsByReport: Map<string, string[]>;
  /** 有意タグ → そのタグを持つレポート */
  reportsByTag: Map<string, string[]>;
  idf: Map<string, number>;
}

// ビルドは単一プロセスなので、Promise をキャッシュすれば並行呼び出しでも 1 回で済む。
let indexPromise: Promise<RelatedIndex> | null = null;

async function buildIndex(): Promise<RelatedIndex> {
  const [tagMap, unpublished] = await Promise.all([getAllReportTags(), getUnpublishedIds()]);

  // 候補になるのは「ページが生成される公開済みレポート」だけ。
  // 旧 API は published のみで絞っていたため、ページを持たないレポートを
  // 関連として返すことがあった。ここではその取りこぼしも同時に閉じる。
  const meta = new Map<string, ReportMeta>();
  for (const f of features) {
    const reports = (await getAllReports(f.slug)) as unknown as ReportEntryLike[];
    for (const entry of reports) {
      const d1Id = toD1Id(f.slug, entry.id);
      if (unpublished.has(d1Id)) continue;
      meta.set(d1Id, {
        slug: entry.id,
        feature: f.slug,
        date: entry.data.date,
        title: entry.data.title,
      });
    }
  }

  // df (document frequency) は候補集合の中だけで数える
  const df = new Map<string, number>();
  for (const d1Id of meta.keys()) {
    for (const { tag } of tagMap.get(d1Id) ?? []) {
      df.set(tag, (df.get(tag) ?? 0) + 1);
    }
  }

  const total = meta.size;
  const genericThreshold = Math.max(2, Math.floor(total * GENERIC_TAG_RATIO));

  const tagsByReport = new Map<string, string[]>();
  const reportsByTag = new Map<string, string[]>();
  const idf = new Map<string, number>();

  for (const d1Id of meta.keys()) {
    const significant: string[] = [];
    for (const { tag } of tagMap.get(d1Id) ?? []) {
      const freq = df.get(tag) ?? 0;
      // df 1 は自分しか持たないタグ = 関連を作れないので落とす
      if (freq < 2 || freq > genericThreshold) continue;
      significant.push(tag);
      if (!idf.has(tag)) idf.set(tag, Math.log(total / freq));
      const bucket = reportsByTag.get(tag);
      if (bucket) bucket.push(d1Id);
      else reportsByTag.set(tag, [d1Id]);
    }
    if (significant.length > 0) tagsByReport.set(d1Id, significant);
  }

  return { meta, tagsByReport, reportsByTag, idf };
}

/**
 * 指定レポートの関連レポートを、共有タグの IDF 重み付けスコア順に返す。
 *
 * @param d1Id - 対象レポートの D1 形式 ID (`toD1Id()` の戻り値)
 * @param limit - 返す最大件数
 * @returns スコア降順・同点なら日付降順の関連レポート。有意タグを持たない場合は空配列
 */
export async function getRelatedReports(d1Id: string, limit = 5): Promise<RelatedReport[]> {
  if (!indexPromise) indexPromise = buildIndex();
  const index = await indexPromise;

  const myTags = index.tagsByReport.get(d1Id);
  if (!myTags || myTags.length === 0) return [];

  const scores = new Map<string, { score: number; tags: string[] }>();
  for (const tag of myTags) {
    const weight = index.idf.get(tag) ?? 0;
    for (const otherId of index.reportsByTag.get(tag) ?? []) {
      if (otherId === d1Id) continue;
      const hit = scores.get(otherId);
      if (hit) {
        hit.score += weight;
        hit.tags.push(tag);
      } else {
        scores.set(otherId, { score: weight, tags: [tag] });
      }
    }
  }

  // ビルドを決定的にするため、同点は date 降順 → ID 昇順で必ず一意に並べる
  const ranked = [...scores.entries()].sort((a, b) => {
    if (b[1].score !== a[1].score) return b[1].score - a[1].score;
    const dateDiff = (index.meta.get(b[0])?.date ?? '').localeCompare(
      index.meta.get(a[0])?.date ?? ''
    );
    if (dateDiff !== 0) return dateDiff;
    return a[0].localeCompare(b[0]);
  });

  const related: RelatedReport[] = [];
  for (const [otherId, hit] of ranked) {
    const m = index.meta.get(otherId);
    if (!m) continue;
    related.push({
      report_id: otherId,
      slug: m.slug,
      feature: m.feature,
      date: m.date,
      title: m.title,
      shared_tags: hit.tags,
      shared_count: hit.tags.length,
    });
    if (related.length >= limit) break;
  }
  return related;
}
