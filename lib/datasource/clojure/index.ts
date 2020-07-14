import { GetReleasesConfig, ReleaseResult } from '../common';
import { Datasource } from '../datasource';
import { getReleases } from '../maven';
import { MAVEN_REPO } from '../maven/common';

export const id = 'clojure';

export const defaultRegistryUrls = ['https://clojars.org/repo', MAVEN_REPO];
export const registryStrategy = 'merge';

export class Clojure extends Datasource {
  readonly id = 'clojure';

  getReleases({
    lookupName,
    registryUrl,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    return getReleases({ lookupName, registryUrl });
  }
}
