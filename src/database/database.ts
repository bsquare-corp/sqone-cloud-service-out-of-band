import { Database } from '@bsquare/companion-service-common';
import Path from 'path';

export class OutOfBandDb extends Database {
  public override async connect(): Promise<void> {
    // TODO Require right update for new OOB permissions
    await super.connect(['auth2_055_update-permissions']);
    await this.applyUpdate('oob_001_init', '001_init.sql');
  }

  public override async applyUpdate(patchName: string, file: string): Promise<void> {
    // Makes the paths relative
    await super.applyUpdate(patchName, Path.resolve(Path.dirname(__filename), 'updates', file));
  }
}
