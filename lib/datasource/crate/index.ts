import * as packageCache from '../../util/cache/package';
import { GetReleasesConfig, Release, ReleaseResult } from '../common';
import { Datasource } from '../datasource';

export const id = 'crate';

export class Crate extends Datasource {
  readonly id = 'crate';

  // this.handleErrors will always throw
  // eslint-disable-next-line consistent-return
  async getReleases({
    lookupName,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    const cacheNamespace = 'datasource-crate';
    const cacheKey = lookupName;
    const cachedResult = await packageCache.get<ReleaseResult>(
      cacheNamespace,
      cacheKey
    );
    // istanbul ignore if
    if (cachedResult) {
      return cachedResult;
    }

    const len = lookupName.length;
    let path: string;
    // Ignored because there is no way to test this without hitting up GitHub API
    /* istanbul ignore next */
    if (len === 1) {
      path = '1/' + lookupName;
    } else if (len === 2) {
      path = '2/' + lookupName;
    } else if (len === 3) {
      path = '3/' + lookupName[0] + '/' + lookupName;
    } else {
      path =
        lookupName.slice(0, 2) +
        '/' +
        lookupName.slice(2, 4) +
        '/' +
        lookupName;
    }
    const baseUrl =
      'https://raw.githubusercontent.com/rust-lang/crates.io-index/master/';
    const crateUrl = baseUrl + path;
    try {
      const lines = (await this.http.get(crateUrl)).body
        .split('\n') // break into lines
        .map((line) => line.trim()) // remove whitespace
        .filter((line) => line.length !== 0) // remove empty lines
        .map((line) => JSON.parse(line)); // parse
      const result: ReleaseResult = {
        releases: [],
      };
      result.releases = lines
        .map((version: { vers: string; yanked: boolean }) => {
          const release: Release = {
            version: version.vers,
          };
          if (version.yanked) {
            release.isDeprecated = true;
          }
          return release;
        })
        .filter((release) => release.version);
      if (!result.releases.length) {
        return null;
      }
      const cacheMinutes = 10;
      await packageCache.set(cacheNamespace, cacheKey, result, cacheMinutes);
      return result;
    } catch (err) {
      this.handleGenericErrors(err);
    }
  }
}
