import type { Database } from '../../db/database.ts';
import { fromJson, toJson } from '../../db/database.ts';
import type { Campaign } from './campaign.types.ts';

interface CampaignRow {
  id: string;
  name: string;
  status: Campaign['status'];
  settings: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const toCampaign = (row: CampaignRow): Campaign => ({
  id: row.id,
  name: row.name,
  status: row.status,
  settings: fromJson(row.settings, {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

const toParams = (campaign: Campaign) => ({ ...campaign, settings: toJson(campaign.settings) });

export class CampaignRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async list(): Promise<Campaign[]> {
    return this.db.all<CampaignRow>('SELECT * FROM campaigns ORDER BY created_at DESC').map(toCampaign);
  }

  async findById(id: string): Promise<Campaign | null> {
    const row = this.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = :id', { id });
    return row ? toCampaign(row) : null;
  }

  async insert(campaign: Campaign, lineIds: readonly string[]): Promise<void> {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO campaigns (id, name, status, settings, created_at, updated_at, started_at, finished_at)
         VALUES (:id, :name, :status, :settings, :createdAt, :updatedAt, :startedAt, :finishedAt)`,
        toParams(campaign),
      );
      this.replaceLinesSync(campaign.id, lineIds);
    });
  }

  async save(campaign: Campaign): Promise<void> {
    const { createdAt: _createdAt, ...params } = toParams(campaign);
    this.db.run(
      `UPDATE campaigns SET name = :name, status = :status, settings = :settings, updated_at = :updatedAt,
         started_at = :startedAt, finished_at = :finishedAt WHERE id = :id`,
      params,
    );
  }

  async delete(id: string): Promise<void> {
    this.db.run('DELETE FROM campaigns WHERE id = :id', { id });
  }

  async lineIds(campaignId: string): Promise<string[]> {
    return this.db
      .all<{ line_id: string }>(
        `SELECT cl.line_id FROM campaign_lines cl JOIN lines l ON l.id = cl.line_id
         WHERE cl.campaign_id = :campaignId ORDER BY l.position, l.created_at`,
        { campaignId },
      )
      .map((row) => row.line_id);
  }

  /** Todos os processos em que a linha está selecionada, do mais recente ao mais antigo. */
  async idsForLine(lineId: string): Promise<string[]> {
    return this.db
      .all<{ id: string }>(
        `SELECT c.id FROM campaigns c JOIN campaign_lines cl ON cl.campaign_id = c.id
         WHERE cl.line_id = :lineId ORDER BY c.created_at DESC`,
        { lineId },
      )
      .map((row) => row.id);
  }

  /** Processos em andamento dos quais a linha participa, do mais antigo ao mais novo. */
  async runningIdsForLine(lineId: string): Promise<string[]> {
    return this.db
      .all<{ id: string }>(
        `SELECT c.id FROM campaigns c JOIN campaign_lines cl ON cl.campaign_id = c.id
         WHERE cl.line_id = :lineId AND c.status = 'running'
         ORDER BY c.started_at, c.created_at`,
        { lineId },
      )
      .map((row) => row.id);
  }

  async replaceLines(campaignId: string, lineIds: readonly string[]): Promise<void> {
    this.db.transaction(() => this.replaceLinesSync(campaignId, lineIds));
  }

  private replaceLinesSync(campaignId: string, lineIds: readonly string[]): void {
    this.db.run('DELETE FROM campaign_lines WHERE campaign_id = :campaignId', { campaignId });
    for (const lineId of new Set(lineIds)) {
      this.db.run('INSERT INTO campaign_lines (campaign_id, line_id) VALUES (:campaignId, :lineId)', { campaignId, lineId });
    }
  }
}
