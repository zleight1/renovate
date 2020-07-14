import { ExternalHostError } from '../../types/errors/external-host-error';
import { HttpError } from '../../util/http';
import { CachePromise, cacheAble } from '../cache';
import { GetReleasesConfig, ReleaseResult } from '../common';
import { Datasource } from '../datasource';

export const id = 'cdnjs';

interface CdnjsAsset {
  version: string;
  files: string[];
  sri?: Record<string, string>;
}

interface CdnjsResponse {
  homepage?: string;
  repository?: {
    type: 'git' | unknown;
    url?: string;
  };
  assets?: CdnjsAsset[];
}

export class CdnJs extends Datasource {
  readonly id = 'cdnjs';

  private async downloadLibrary(library: string): CachePromise<CdnjsResponse> {
    const url = `https://api.cdnjs.com/libraries/${library}?fields=homepage,repository,assets`;
    return { data: (await this.http.getJson<CdnjsResponse>(url)).body };
  }

  handleSpecificErrors(err: HttpError): void {
    if (err.statusCode !== 404) {
      throw new ExternalHostError(err);
    }
  }

  // this.handleErrors will always throw
  // eslint-disable-next-line consistent-return
  async getReleases({
    lookupName,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    const library = lookupName.split('/')[0];
    try {
      const { assets, homepage, repository } = await cacheAble({
        id,
        lookup: library,
        cb: () => this.downloadLibrary(library),
      });
      if (!assets) {
        return null;
      }
      const assetName = lookupName.replace(`${library}/`, '');
      const releases = assets
        .filter(({ files }) => files.includes(assetName))
        .map(({ version, sri }) => ({ version, newDigest: sri[assetName] }));

      const result: ReleaseResult = { releases };

      if (homepage) {
        result.homepage = homepage;
      }
      if (repository?.url) {
        result.sourceUrl = repository.url;
      }
      return result;
    } catch (err) {
      if (err.statusCode !== undefined && err.statusCode !== 404) {
        throw new ExternalHostError(err);
      }
      this.handleGenericErrors(err);
    }
  }
}
