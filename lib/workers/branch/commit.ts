import is from '@sindresorhus/is';
import minimatch from 'minimatch';
import { platform } from '../../platform';
import { logger } from '../../logger';
import { BranchConfig } from '../common';

export async function commitFilesToBranch(
  config: BranchConfig
): Promise<{ commitHash: string | null; reason: string }> {
  let updatedFiles = config.updatedPackageFiles.concat(config.updatedArtifacts);
  // istanbul ignore if
  if (is.nonEmptyArray(config.excludeCommitPaths)) {
    updatedFiles = updatedFiles.filter(f => {
      const filename = f.name === '|delete|' ? f.contents.toString() : f.name;
      const matchesExcludePaths = config.excludeCommitPaths.some(path =>
        minimatch(filename, path, { dot: true })
      );
      if (matchesExcludePaths) {
        logger.debug(`Excluding ${filename} from commit`);
        return false;
      }
      return true;
    });
  }
  if (!is.nonEmptyArray(updatedFiles)) {
    logger.debug(`No files to commit`);
    return { commitHash: null, reason: 'no-updated-files' };
  }
  logger.debug(`${updatedFiles.length} file(s) to commit`);
  // istanbul ignore if
  if (config.dryRun) {
    logger.info('DRY-RUN: Would commit files to branch ' + config.branchName);
    return { commitHash: null, reason: 'dry-run' };
  }
  // API will know whether to create new branch or not
  const commitHash = await platform.commitFilesToBranch({
    branchName: config.branchName,
    files: updatedFiles,
    message: config.commitMessage,
    parentBranch: config.baseBranch || undefined,
  });
  return { commitHash, reason: 'platform' };
}
