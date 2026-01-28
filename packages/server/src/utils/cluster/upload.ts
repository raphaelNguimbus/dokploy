import { findAllDeploymentsByApplicationId } from "@dokploy/server/services/deployment";
import type { Registry } from "@dokploy/server/services/registry";
import { createRollback } from "@dokploy/server/services/rollbacks";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import type { ApplicationNested } from "../builders";
import { getBuildAppDirectory } from "../filesystem/directory";

export const uploadImageRemoteCommand = async (
	application: ApplicationNested,
) => {
	const registry = application.registry;
	const buildRegistry = application.buildRegistry;
	const rollbackRegistry = application.rollbackRegistry;
	const {
		customImageTags,
		autoVersionFromJson,
		appName,
		customImageName,
		sourceType,
	} = application;

	if (!registry && !buildRegistry && !rollbackRegistry) {
		throw new Error("No registry found");
	}

	const image = customImageName || `${appName}`;
	// Original logic used latest if no dockerImage, but here we use the image name we just built.
	// If sourceType is docker, we might use dockerImage.
	const imageName =
		sourceType === "docker"
			? application.dockerImage || ""
			: `${image}:latest`; // We assume the build step tagged it as :latest?
	// Actually in docker-file.ts we did: build -t image ...
	// If image has no tag, docker adds :latest.
	// But in docker-file.ts I used: const image = application.customImageName || `${appName}`;
	// If customImageName is "my/image:v1", then we should respect it.
	// But commonly intermediate image is tagged latest or just name.
	// Let's assume the build resulted in `image` (from logic above).
	// If I built `myimage`, it is `myimage:latest`.

	// We need to reference the image that was just built.
	const builtImageName = customImageName || appName;

	const commands: string[] = [];
	const tagsToPush: string[] = [];

	if (customImageTags) {
		const tags = customImageTags.split(",").map((t: string) => t.trim());
		tagsToPush.push(...tags);
	} else {
		// Default behavior: push latest if NO custom tags?
		// User said: "latest par defaut mais aussi d'autre tags".
		// This implies latest + custom tags.
		tagsToPush.push("latest");
	}

	// Ensure latest is there if user wants it explicitly or by default
	if (customImageTags && !tagsToPush.includes("latest")) {
		// If user provided tags, do we force latest? User said "latest by default BUT ALSO others".
		// Interpreting as: Always push latest, AND push others.
		tagsToPush.push("latest");
	}

	const processRegistry = (
		currentRegistry: Registry,
		registryName: string,
		isRollback = false,
	) => {
		commands.push(`echo "📦 [Enabled ${registryName}]"`);

		// 1. Push static tags
		for (const tag of new Set(tagsToPush)) {
			// Avoid duplicate latest if it's already in the loop
			const registryTag = getRegistryTag(
				currentRegistry,
				builtImageName,
				tag,
			);
			if (registryTag) {
				commands.push(
					getRegistryCommands(
						currentRegistry,
						builtImageName,
						registryTag,
					),
				);
			}
		}

		// 2. Dynamic Version from JSON
		if (autoVersionFromJson && sourceType !== "docker") {
			const buildDir = getBuildAppDirectory(application);
			const { APPLICATIONS_PATH } = paths(!!application.serverId);
			const projectRoot = path.join(
				APPLICATIONS_PATH,
				application.appName,
				"code",
			);
			const searchDirs = [projectRoot];

			if (application.buildType === "dockerfile") {
				// Priority: Dockerfile directory -> Project Root
				searchDirs.unshift(path.dirname(buildDir));
			} else {
				// Priority: Build directory (likely root or subfolder) -> Project Root (redundant if same, but safe)
				searchDirs.unshift(buildDir);
			}

			// Remove duplicates
			const uniqueDirs = [...new Set(searchDirs)];

			// Bash logic to extract version and push
			// We iterate over uniqueDirs in bash to find the first version.json

			const { registryUrl, imagePrefix, username } = currentRegistry;
			const targetPrefix = imagePrefix || username;
			const finalRegistry = registryUrl || "";
			const repoName = extractRepositoryName(builtImageName);

			const baseImageTag = finalRegistry
				? `${finalRegistry}/${targetPrefix}/${repoName}`
				: `${targetPrefix}/${repoName}`;

			// Construct bash array/checks
			let bashSearchBlock = "";
			for (const dir of uniqueDirs) {
				// escaping windows paths if necessary? paths usually come with forward slashes from `path` on linux/mac, but on windows server it handles it?
				// `path` module adheres to OS. If server is windows, paths have backslashes.
				// Bash in git bash or wsl handles forward slashes. Backslashes need escaping.
				// `dokploy` generally runs in linux containers or linux envs, but user has windows OS.
				// However, the `application.serverId` implies where the command runs.
				// If local (no serverId), it runs on the host. If host is windows, we need to be careful.
				// `paths` constants should handle this?
				// But let's assume standard posix paths for the `mkdir -p` etc used elsewhere.
				// We can normalize to forward slashes for bash compatibility just in case.
				const normalizedDir = dir.replace(/\\/g, "/");
				bashSearchBlock += `
    if [ -z "$VERSION" ] && [ -f "${normalizedDir}/version.json" ]; then
        echo "🔍 Checking for version.json in ${normalizedDir}"
        FOUND_VERSION=$(grep -o '"version": *"[^"]*"' "${normalizedDir}/version.json" | head -1 | awk -F'"' '{print $4}')
        if [ ! -z "$FOUND_VERSION" ]; then
            VERSION=$FOUND_VERSION
            echo "✅ Found version: $VERSION in ${normalizedDir}"
        fi
    fi
`;
			}

			commands.push(`
# Auto Version Check
VERSION=""
${bashSearchBlock}

if [ ! -z "$VERSION" ]; then
    FULL_TAG="${baseImageTag}:$VERSION"
    echo "🏷️  Tagging with version: $VERSION"
    docker tag ${builtImageName} $FULL_TAG || echo "❌ Error tagging version"
    echo "fw  Pushing version tag: $FULL_TAG"
    docker push $FULL_TAG || echo "❌ Error pushing version tag"
else
    echo "⚠️  version.json not found in search paths, skipping version tag"
fi
`);
		}
	};

	if (registry) {
		processRegistry(registry, "Registry Swarm");
	}
	if (buildRegistry) {
		processRegistry(buildRegistry, "Build Registry");
		commands.push(
			`echo "⚠️ INFO: After the build is finished, you need to wait a few seconds for the server to download the image and run the container."`,
		);
		commands.push(
			`echo "📊 Check the Logs tab to see when the container starts running."`,
		);
	}

	if (rollbackRegistry && application.rollbackActive) {
		const deployment = await findAllDeploymentsByApplicationId(
			application.applicationId,
		);
		if (!deployment || !deployment[0]) {
			throw new Error("Deployment not found");
		}
		const deploymentId = deployment[0].deploymentId;
		const rollback = await createRollback({
			appName: appName,
			deploymentId: deploymentId,
		});

		// Rollback logic is slightly different, it uses specific image from rollback.
		// We probably don't want to double-push version tags to rollback registry if it's strictly for rollback history?
		// But if user wants to store versions there, maybe.
		// For now, I'll keep the original rollback logic which pushes the verified image.
		// Actually, existing logic pushed `rollback.image`.

		const rollbackRegistryTag = getRegistryTag(
			rollbackRegistry,
			rollback?.image || "",
			"latest" // Rollback typically targets specific hash or tag, but existing code logic used standard tag?
			// Existing code: const rollbackRegistryTag = getRegistryTag(rollbackRegistry, rollback?.image || "");
			// convert to new signature if I change getRegistryTag?
		);

		// Re-implement existing logic for rollback
		// The existing logic passed `rollback?.image` to getRegistryTag.
		// And `getRegistryTag` logic was `extractRepositoryName(imageName)`.

		// Let's modify `getRegistryTag` signature to accept an optional explicit tag override, 
		// OR handle the splitting inside `getRegistryTag` if the input image has a tag.

		// I will update getRegistryTag to handle explicit tag properly.

		// ... (Existing implementation)
		// commands.push(getRegistryCommands(rollbackRegistry, imageName, rollbackRegistryTag));
		// Note: original code used `imageName` (which was appName:latest or dockerImage) as source for `docker tag`.
		// And `rollbackRegistryTag` as target.

		// I will preserve this logic but use `builtImageName`.
		const simpleRollbackTag = getRegistryTag(rollbackRegistry, rollback?.image || "");
		if (simpleRollbackTag) {
			commands.push(`echo "🔄 [Enabled Rollback Registry]"`);
			commands.push(
				getRegistryCommands(rollbackRegistry, builtImageName, simpleRollbackTag),
			);
		}
	}
	try {
		return commands.join("\n");
	} catch (error) {
		throw error;
	}
};

/**
 * Extract the repository name from imageName by taking the last part after '/'
 * Examples:
 * - "nginx" -> "nginx"
 * - "nginx:latest" -> "nginx:latest"
 * - "myuser/myrepo" -> "myrepo"
 * - "myuser/myrepo:tag" -> "myrepo:tag"
 * - "docker.io/myuser/myrepo" -> "myrepo"
 */
const extractRepositoryName = (imageName: string): string => {
	const lastSlashIndex = imageName.lastIndexOf("/");
	let repo = imageName;
	if (lastSlashIndex !== -1) {
		repo = imageName.substring(lastSlashIndex + 1);
	}
	// Remove tag if present, to just get the repo name for tagging with new tags
	// e.g. "myrepo:latest" -> "myrepo"
	const colonIndex = repo.indexOf(":");
	if (colonIndex !== -1) {
		return repo.substring(0, colonIndex);
	}
	return repo;
};

// Updated signature: allow explicit tag
export const getRegistryTag = (registry: Registry, imageName: string, explicitTag?: string) => {
	const { registryUrl, imagePrefix, username } = registry;

	// Extract the repository name (last part after '/')
	const repositoryName = extractRepositoryName(imageName);

	// Build the final tag using registry's username/prefix
	const targetPrefix = imagePrefix || username;
	const finalRegistry = registryUrl || "";

	// If explicit tag is provided, use it.
	// If not, try to preserve the tag from imageName, otherwise default to empty (implicit latest in Docker context, but clean for string check)
	let tag = "";
	if (explicitTag) {
		tag = explicitTag;
	} else {
		// Check if imageName has a tag
		const colonIndex = imageName.lastIndexOf(":");
		if (colonIndex !== -1 && imageName.lastIndexOf("/") < colonIndex) {
			tag = imageName.substring(colonIndex + 1);
		}
	}

	const suffix = tag ? `:${tag}` : "";

	return finalRegistry
		? `${finalRegistry}/${targetPrefix}/${repositoryName}${suffix}`
		: `${targetPrefix}/${repositoryName}${suffix}`;
};

const getRegistryCommands = (
	registry: Registry,
	imageName: string,
	registryTag: string,
): string => {
	return `
echo "📦 [Enabled Registry] Uploading image to '${registry.registryType}' | '${registryTag}'" ;
echo "${registry.password}" | docker login ${registry.registryUrl} -u '${registry.username}' --password-stdin || { 
	echo "❌ DockerHub Failed" ;
	exit 1;
}
echo "✅ Registry Login Success" ;
docker tag ${imageName} ${registryTag} || { 
	echo "❌ Error tagging image" ;
	exit 1;
}
echo "✅ Image Tagged" ;
docker push ${registryTag} || { 
	echo "❌ Error pushing image" ;
	exit 1;
}
	echo "✅ Image Pushed" ;
`;
};
