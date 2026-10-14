/**
 * Serving stored files. Nothing in object storage is public: every byte goes through here.
 *
 *   GET /v1/files/avatar/:personId          a colleague's picture
 *   GET /v1/files/card/:leadId/:side        the card photo of a lead they may read
 *   GET /v1/files/attachment/:eventId/:id   an event's briefing document
 *
 * Two ways to prove you may have it. A bearer token, as everywhere else — and, because an <img>
 * tag cannot send one, a short-lived signature on the path itself (crypto.ts · signPath). The
 * signature says nothing about who is asking, so it is only used for pictures that are already
 * visible to everyone in the company.
 *
 * Images are sent with `Cache-Control: private`, so no shared proxy keeps a copy.
 */
import { Controller, Get, Header, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { pathSignatureOk } from '../../common/crypto';
import { DbService, type Caller } from '../../common/db.service';
import { notFound, unauthorized } from '../../common/errors';
import { Public, bearer, type RequestWithCaller } from '../../common/guards';
import { SessionService } from '../../common/session.service';
import { StorageService } from '../../common/storage.service';
import { parse, uuid } from '../../common/validation';

@Public()
@Controller('v1/files')
export class FilesController {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly sessions: SessionService,
  ) {}

  /** Either a valid session, or a valid signature for exactly this path. */
  private async who(req: RequestWithCaller, path: string, exp?: string, sig?: string): Promise<Caller | null> {
    if (pathSignatureOk(path, exp, sig)) return null;
    const session = await this.sessions.require(bearer(req), 'ready');
    return { personId: session.person_id, companyId: session.company_id, role: session.role };
  }

  @Get('avatar/:personId')
  @Header('Cache-Control', 'private, max-age=300')
  async avatar(
    @Req() req: RequestWithCaller,
    @Param('personId') personId: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    const id = parse(uuid, personId);
    const me = await this.who(req, `/v1/files/avatar/${id}`, exp, sig);
    if (me) {
      // The policy on `people` already limits this to the caller's own company.
      const row = await this.db.asOne<{ id: string }>(me, 'select id from people where id = $1', [id]);
      if (!row) throw notFound('That picture');
    }
    return this.send(res, StorageService.avatarKey(id), 'image/jpeg');
  }

  @Get('card/:leadId/:side')
  @Header('Cache-Control', 'private, max-age=60')
  async card(
    @Req() req: RequestWithCaller,
    @Param('leadId') leadId: string,
    @Param('side') side: string,
    @Res() res: Response,
  ) {
    const id = parse(uuid, leadId);
    const which = side === 'back' ? 'back' : 'front';
    // A card photo is a visitor's details: a session, always — no signed links for these.
    const me = await this.who(req, '', undefined, undefined);
    if (!me) throw unauthorized();
    const row = await this.db.asOne<{ storage_key: string; mime: string }>(me,
      `select bc.storage_key, bc.mime from business_cards bc
         join leads l on l.id = bc.lead_id
        where bc.lead_id = $1 and bc.side = $2::photo_side`,
      [id, which]);
    if (!row) throw notFound('That photo');
    return this.send(res, row.storage_key, row.mime);
  }

  @Get('attachment/:eventId/:attachmentId')
  @Header('Cache-Control', 'private, max-age=300')
  async attachment(
    @Req() req: RequestWithCaller,
    @Param('eventId') eventId: string,
    @Param('attachmentId') attachmentId: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    const ev = parse(uuid, eventId);
    const att = parse(uuid, attachmentId);
    const me = await this.who(req, `/v1/files/attachment/${ev}/${att}`, exp, sig);
    const row = me
      ? await this.db.asOne<{ url: string; mime: string; name: string }>(me,
        `select a->>'url' as url, a->>'mime' as mime, a->>'name' as name
           from events e, lateral jsonb_array_elements(e.attachments) a
          where e.id = $1 and a->>'id' = $2`, [ev, att])
      : await this.db.one<{ url: string; mime: string; name: string }>(
        `select a->>'url' as url, a->>'mime' as mime, a->>'name' as name
           from events e, lateral jsonb_array_elements(e.attachments) a
          where e.id = $1 and a->>'id' = $2`, [ev, att]);
    if (!row) throw notFound('That file');
    res.setHeader('Content-Disposition', `inline; filename="${row.name.replace(/[^\w.\- ]/g, '_')}"`);
    return this.send(res, row.url, row.mime || 'application/octet-stream');
  }

  private async send(res: Response, key: string, mime: string) {
    const body = await this.storage.get(key);
    if (!body) throw notFound('That file');
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  }
}
