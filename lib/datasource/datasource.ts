import { ExternalHostError } from '../types/errors/external-host-error';
import { Http, HttpError } from '../util/http';
import { GetReleasesConfig, ReleaseResult } from './common';

export abstract class Datasource {
  constructor() {
    this.http = new Http(this.getId());
  }

  abstract id: string;

  getId(): string {
    return this.id;
  }

  protected http: Http;

  abstract getReleases(
    getReleasesConfig: GetReleasesConfig
  ): Promise<ReleaseResult | null>;

  handleSpecificErrors(err: HttpError): void {}

  protected handleGenericErrors(err: HttpError): never {
    this.handleSpecificErrors(err);
    if (err.statusCode !== undefined) {
      if (
        err.statusCode === 429 ||
        (err.statusCode >= 500 && err.statusCode < 600)
      ) {
        throw new ExternalHostError(err);
      }
    }
    throw err;
  }
}
