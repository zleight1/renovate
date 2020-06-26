import { Merge } from 'type-fest';
import { PackageDependency, ArtifactError } from '../manager/common';
import {
  RenovateSharedConfig,
  RenovateConfig,
  GroupConfig,
  RenovateAdminConfig,
  ValidationMessage,
} from '../config';
import { LookupUpdate } from './repository/process/lookup/common';
import { FileData, PlatformPrOptions } from '../platform';
import { Release } from '../datasource';

export interface BranchUpgradeConfig
  extends Merge<RenovateConfig, PackageDependency>,
    Partial<LookupUpdate>,
    RenovateSharedConfig {
  artifactErrors?: ArtifactError[];
  branchName: string;
  commitMessage?: string;
  currentDigest?: string;
  currentDigestShort?: string;
  currentValue?: string;
  currentVersion?: string;

  endpoint?: string;
  excludeCommitPaths?: string[];
  group?: GroupConfig;

  groupName?: string;
  groupSlug?: string;
  language?: string;
  manager?: string;
  packageFile?: string;

  parentBranch?: string;
  prBodyNotes?: string[];
  prPriority?: number;
  prTitle?: string;
  releases?: Release[];
  releaseTimestamp?: string;

  sourceDirectory?: string;
  updatedPackageFiles?: FileData[];
  updatedArtifacts?: FileData[];
}

export enum BranchResult {
  Automerged = 'Automerged',
  AwaitingApproval = 'AwaitingApproval',
  AwaitingHourlyLimit = 'AwaitingHourlyLimit',
  AwaitingScheduledCreation = 'AwaitingScheduledCreation',
  AwaitingScheduledUpdate = 'AwaitingScheduledUpdate',
  AwaitingStability = 'AwaitingStability',
  BlockedByClosedPr = 'BlockedByClosedPr',
  BlockedByCommits = 'BlockedByCommits',
  Created = 'Created',
  Deleted = 'Deleted',
  ErrorBundler = 'ErrorBundler',
  ErrorNoCommit = 'ErrorNoCommit',
  ErrorUnknown = 'ErrorUnknown',
  NotUpdated = 'NotUpdated',
  PointlessRebase = 'PointlessRebase',
  Rebased = 'Rebased',
  NotAttempted = 'NotAttempted',
}

export enum PrResult {
  Automerged = 'Automerged',
  AwaitingApproval = 'AwaitingApproval',
  AwaitingGreenBranch = 'AwaitingGreenBranch',
  AwaitingNotPending = 'AwaitingNotPending',
  BlockedByBranchAutomerge = 'BlockedByBranchAutomerge',
  Created = 'Created',
  Error = 'Error',
  ErrorAlreadyExists = 'ErrorAlreadyExists',
  NotAttempted = 'NotAttempted',
  NotUpdated = 'NotUpdated',
  Updated = 'Updated',
}

export interface ProcessBranchResult {
  branchExists: boolean;
  branchResult: BranchResult;
  prExists: boolean;
  prResult: PrResult;
}

export interface BranchConfig
  extends BranchUpgradeConfig,
    RenovateAdminConfig,
    PlatformPrOptions {
  automergeType?: string;
  baseBranch?: string;
  canBeUnpublished?: boolean;
  errors?: ValidationMessage[];
  hasTypes?: boolean;
  releaseTimestamp?: string;

  res?: ProcessBranchResult;
  upgrades: BranchUpgradeConfig[];
}
