CREATE TABLE `appSettings` (
	`key` varchar(128) NOT NULL,
	`value` text NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `appSettings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `chapterJobs` (
	`id` varchar(36) NOT NULL,
	`sourceId` int NOT NULL,
	`urlHash` varchar(64) NOT NULL,
	`canonicalUrl` varchar(1024) NOT NULL,
	`requestedByDiscordId` varchar(32) NOT NULL,
	`requestedByName` varchar(160) NOT NULL,
	`requestedInChannelId` varchar(32),
	`sourceChapterId` varchar(160),
	`mangaTitle` varchar(512),
	`chapterTitle` varchar(512),
	`jobStatus` enum('pending','downloading','uploading','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
	`totalPages` int NOT NULL DEFAULT 0,
	`uploadedPages` int NOT NULL DEFAULT 0,
	`googleDriveFolderId` varchar(160),
	`googleDriveUrl` varchar(1024),
	`failureCode` varchar(120),
	`failureMessage` text,
	`cancelRequested` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `chapterJobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `chapterJobs_urlHash_unique` UNIQUE(`urlHash`)
);
--> statement-breakpoint
CREATE TABLE `contentSources` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`hostname` varchar(255) NOT NULL,
	`baseUrl` varchar(512) NOT NULL,
	`suwayomiSourceId` varchar(128),
	`extensionPackage` varchar(256),
	`extensionName` varchar(160),
	`sourceStatus` enum('active','disabled') NOT NULL DEFAULT 'disabled',
	`documentedIntegrationUrl` varchar(1024),
	`allowDirectChapterLookup` boolean NOT NULL DEFAULT false,
	`rejectLoginRequired` boolean NOT NULL DEFAULT true,
	`rejectCaptchaRequired` boolean NOT NULL DEFAULT true,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contentSources_id` PRIMARY KEY(`id`),
	CONSTRAINT `contentSources_hostname_unique` UNIQUE(`hostname`)
);
--> statement-breakpoint
CREATE TABLE `discordRoles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`discordRoleId` varchar(32) NOT NULL,
	`label` varchar(120) NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `discordRoles_id` PRIMARY KEY(`id`),
	CONSTRAINT `discordRoles_role_unique` UNIQUE(`discordRoleId`)
);
--> statement-breakpoint
CREATE TABLE `integrationHealth` (
	`id` int AUTO_INCREMENT NOT NULL,
	`service` varchar(64) NOT NULL,
	`healthStatus` enum('healthy','degraded','offline','unknown') NOT NULL DEFAULT 'unknown',
	`message` text,
	`consecutiveFailures` int NOT NULL DEFAULT 0,
	`lastCheckedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `integrationHealth_id` PRIMARY KEY(`id`),
	CONSTRAINT `integrationHealth_service_unique` UNIQUE(`service`)
);
--> statement-breakpoint
CREATE TABLE `jobAttempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`phase` varchar(64) NOT NULL,
	`message` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `jobAttempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` MODIFY COLUMN `role` enum('admin','user') NOT NULL DEFAULT 'user';--> statement-breakpoint
CREATE INDEX `chapterJobs_status_createdAt_idx` ON `chapterJobs` (`jobStatus`,`createdAt`);--> statement-breakpoint
CREATE INDEX `chapterJobs_requestedBy_idx` ON `chapterJobs` (`requestedByDiscordId`);--> statement-breakpoint
CREATE INDEX `chapterJobs_source_idx` ON `chapterJobs` (`sourceId`);--> statement-breakpoint
CREATE INDEX `jobAttempts_job_createdAt_idx` ON `jobAttempts` (`jobId`,`createdAt`);