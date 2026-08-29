const fs = require('node:fs');
const path = require('node:path');

const SAFE_PERMISSION_NAMES = new Set([
  'filesystem',
  'network',
  'shell',
  'models',
  'ui',
  'workspace',
]);

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function validatePluginDirectory(pluginDir) {
  const errors = [];
  const warnings = [];
  const manifestPath = path.join(pluginDir, 'package.json');

  if (!fs.existsSync(manifestPath)) {
    return { ok: false, errors: ['package.json is missing.'], warnings, manifest: null };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`package.json is invalid JSON: ${error.message}`], warnings, manifest: null };
  }

  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    errors.push('package.json must contain a non-empty "name".');
  } else if (manifest.name.length > 214 || !PACKAGE_NAME_PATTERN.test(manifest.name)) {
    errors.push('package.json "name" must be a safe npm-style package name.');
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    errors.push('package.json must contain a non-empty "version".');
  } else if (manifest.version.length > 128 || !SEMVER_PATTERN.test(manifest.version)) {
    errors.push('package.json "version" must be a valid semantic version.');
  }

  const patch = manifest?.dsh?.bundle?.patch;
  if (typeof patch !== 'string' || !patch.trim()) {
    errors.push('Plugin must declare dsh.bundle.patch in package.json.');
  } else {
    const normalized = path.normalize(patch);
    if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
      errors.push('dsh.bundle.patch must point to a file inside the plugin.');
    } else if (!fs.existsSync(path.join(pluginDir, normalized))) {
      errors.push(`Declared bundle patch does not exist: ${patch}`);
    } else if (!fs.statSync(path.join(pluginDir, normalized)).isFile()) {
      errors.push(`Declared bundle patch is not a file: ${patch}`);
    }
  }

  if (manifest.scripts?.build !== undefined
      && (typeof manifest.scripts.build !== 'string' || !manifest.scripts.build.trim())) {
    errors.push('scripts.build must be a non-empty string when present.');
  }

  const requested = manifest?.harnessDesktop?.permissions;
  let permissions = [];
  if (requested !== undefined) {
    if (!Array.isArray(requested) || requested.some((item) => typeof item !== 'string')) {
      errors.push('harnessDesktop.permissions must be an array of strings when present.');
    } else {
      permissions = [...new Set(requested)];
      for (const permission of permissions) {
        if (!SAFE_PERMISSION_NAMES.has(permission)) {
          warnings.push(`Unknown permission declaration: ${permission}`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    permissions,
    manifest,
  };
}

module.exports = {
  validatePluginDirectory,
  SAFE_PERMISSION_NAMES,
  PACKAGE_NAME_PATTERN,
  SEMVER_PATTERN,
};
