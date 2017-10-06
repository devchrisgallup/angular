'use strict';

const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('canonical-path');
const shelljs = require('shelljs');
const yargs = require('yargs');

const PACKAGE_JSON = 'package.json';
const LOCKFILE = 'yarn.lock';
const LOCAL_MARKER_PATH = 'node_modules/_local_.json';
const PACKAGE_JSON_REGEX = /^[^/]+\/package\.json$/;

const ANGULAR_ROOT_DIR = path.resolve(__dirname, '../../..');
const ANGULAR_DIST_PACKAGES = path.resolve(ANGULAR_ROOT_DIR, 'dist/packages-dist');

/**
 * A tool that can install Angular dependencies for a project from NPM or from the
 * locally built distributables.
 *
 * This tool is used to change dependencies of the `aio` application and the example
 * applications.
 */
class NgPackagesInstaller {

  /**
   * Create a new installer for a project in the specified directory.
   *
   * @param {string} projectDir - the path to the directory containing the project.
   * @param {object} options - a hash of options for the install
   *                           * `debug` (`boolean`) - whether to display debug messages.
   *                           * `force` (`boolean`) - whether to force a local installation
   *                                                   even if there is a local marker file.
   *                           * `ignorePackages` (`string[]`) - a collection of names of packages
   *                                                   that should not be copied over.
   */
  constructor(projectDir, options = {}) {
    this.debug = options.debug;
    this.force = options.force;
    this.projectDir = path.resolve(projectDir);
    this.localMarkerPath = path.resolve(this.projectDir, LOCAL_MARKER_PATH);

    this._log('Project directory:', this.projectDir);
  }

  // Public methods

  /**
   * Check whether the dependencies have been overridden with locally built
   * Angular packages. This is done by checking for the `_local_.json` marker file.
   * This will emit a warning to the console if the dependencies have been overridden.
   */
  checkDependencies() {
    if (this._checkLocalMarker()) {
      this._printWarning();
    }
  }

  /**
   * Install locally built Angular dependencies, overriding the dependencies in the package.json
   * This will also write a "marker" file (`_local_.json`), which contains the overridden package.json
   * contents and acts as an indicator that dependencies have been overridden.
   */
  installLocalDependencies() {
    if (this._checkLocalMarker() !== true || this.force) {
      const pathToPackageConfig = path.resolve(this.projectDir, PACKAGE_JSON);
      const packages = this._getDistPackages();
      const packageConfigFile = fs.readFileSync(pathToPackageConfig);
      const packageConfig = JSON.parse(packageConfigFile);

      const [dependencies, peers] = this._collectDependencies(packageConfig.dependencies || {}, packages);
      const [devDependencies, devPeers] = this._collectDependencies(packageConfig.devDependencies || {}, packages);

      this._assignPeerDependencies(peers, dependencies, devDependencies);
      this._assignPeerDependencies(devPeers, dependencies, devDependencies);

      const localPackageConfig = Object.assign(Object.create(null), packageConfig, { dependencies, devDependencies });
      localPackageConfig.__angular = { local: true };
      const localPackageConfigJson = JSON.stringify(localPackageConfig, null, 2);

      try {
        this._log(`Writing temporary local ${PACKAGE_JSON} to ${pathToPackageConfig}`);
        fs.writeFileSync(pathToPackageConfig, localPackageConfigJson);
        this._installDeps('--no-lockfile', '--check-files');
        this._setLocalMarker(localPackageConfigJson);
      } finally {
        this._log(`Restoring original ${PACKAGE_JSON} to ${pathToPackageConfig}`);
        fs.writeFileSync(pathToPackageConfig, packageConfigFile);
      }
    }
  }

  /**
   * Reinstall the original package.json depdendencies
   * Yarn will also delete the local marker file for us.
   */
  restoreNpmDependencies() {
    this._installDeps('--check-files');
  }

  // Protected helpers

  _assignPeerDependencies(peerDependencies, dependencies, devDependencies) {
    Object.keys(peerDependencies).forEach(key => {
      // If there is already an equivalent dependency then override it - otherwise assign/override the devDependency
      if (dependencies[key]) {
        this._log(`Overriding dependency with peerDependency: ${key}: ${peerDependencies[key]}`);
        dependencies[key] = peerDependencies[key];
      } else {
        this._log(`${devDependencies[key] ? 'Overriding' : 'Assigning'} devDependency with peerDependency: ${key}: ${peerDependencies[key]}`);
        devDependencies[key] = peerDependencies[key];
      }
    });
  }

  _collectDependencies(dependencies, packages) {
    const peerDependencies = Object.create(null);
    const mergedDependencies = Object.assign(Object.create(null), dependencies);

    Object.keys(dependencies).forEach(key => {
      const sourcePackage = packages[key];
      if (sourcePackage) {
        // point the core Angular packages at the distributable folder
        mergedDependencies[key] = `file:${ANGULAR_DIST_PACKAGES}/${key.replace('@angular/', '')}`;
        this._log(`Overriding dependency with local package: ${key}: ${mergedDependencies[key]}`);
        // grab peer dependencies
        Object.keys(sourcePackage.peerDependencies || {})
          // ignore peerDependencies which are already core Angular packages
          .filter(key => !packages[key])
          .forEach(key => peerDependencies[key] = sourcePackage.peerDependencies[key]);
      }
    });
    return [mergedDependencies, peerDependencies];
  }

  /**
   * A hash of Angular package configs.
   * (Detected as directories in '/packages/' that contain a top-level 'package.json' file.)
   */
  _getDistPackages() {
    const packageConfigs = Object.create(null);
    this._log(`Angular distributable directory: ${ANGULAR_DIST_PACKAGES}.`);
    shelljs
      .find(ANGULAR_DIST_PACKAGES)
      .map(filePath => filePath.slice(ANGULAR_DIST_PACKAGES.length + 1))
      .filter(filePath => PACKAGE_JSON_REGEX.test(filePath))
      .forEach(packagePath => {
        const packageConfig = require(path.resolve(ANGULAR_DIST_PACKAGES, packagePath));
        const packageName = `@angular/${packagePath.slice(0, -PACKAGE_JSON.length -1)}`;
        packageConfigs[packageName] = packageConfig;
      });
    this._log('Found the following Angular distributables:', Object.keys(packageConfigs).map(key => `\n - ${key}`));
    return packageConfigs;
  }

  _installDeps(...options) {
    const command = 'yarn install ' + options.join(' ');
    this._log('Installing dependencies with:', command);
    shelljs.exec(command, {cwd: this.projectDir});
  }

  /**
   * Log a message if the `debug` property is set to true.
   * @param {...string[]} messages - The messages to be logged.
   */
  _log(...messages) {
    if (this.debug) {
      const header = `  [${NgPackagesInstaller.name}]: `;
      const indent = ' '.repeat(header.length);
      const message = messages.join(' ');
      console.info(`${header}${message.split('\n').join(`\n${indent}`)}`);
    }
  }

  _printWarning() {
    const relativeScriptPath = path.relative('.', __filename.replace(/\.js$/, ''));
    const absoluteProjectDir = path.resolve(this.projectDir);
    const restoreCmd = `node ${relativeScriptPath} restore ${absoluteProjectDir}`;

    // Log a warning.
    console.warn(chalk.yellow([
      '',
      '!'.repeat(110),
      '!!!',
      '!!!  WARNING',
      '!!!',
      `!!!  The project at "${absoluteProjectDir}" is running against the local Angular build.`,
      '!!!',
      '!!!  To restore the npm packages run:',
      '!!!',
      `!!!    "${restoreCmd}"`,
      '!!!',
      '!'.repeat(110),
      '',
    ].join('\n')));
  }

  // Local marker helpers

  _checkLocalMarker() {
    this._log('Checking for local marker at', this.localMarkerPath);
    return fs.existsSync(this.localMarkerPath);
  }

  _setLocalMarker(contents) {
    this._log('Writing local marker file to', this.localMarkerPath);
    fs.writeFileSync(this.localMarkerPath, contents);
  }
}

function main() {
  shelljs.set('-e');

  yargs
    .usage('$0 <cmd> [args]')

    .option('debug', { describe: 'Print additional debug information.', default: false })
    .option('force', { describe: 'Force the command to execute even if not needed.', default: false })

    .command('overwrite <projectDir> [--force] [--debug]', 'Install dependencies from the locally built Angular distributables.', () => {}, argv => {
      const installer = new NgPackagesInstaller(argv.projectDir, argv);
      installer.installLocalDependencies();
    })
    .command('restore <projectDir> [--debug]', 'Install dependencies from the npm registry.', () => {}, argv => {
      const installer = new NgPackagesInstaller(argv.projectDir, argv);
      installer.restoreNpmDependencies();
    })
    .command('check <projectDir> [--debug]', 'Check that dependencies came from npm. Otherwise display a warning message.', () => {}, argv => {
      const installer = new NgPackagesInstaller(argv.projectDir, argv);
      installer.checkDependencies();
    })
    .demandCommand(1, 'Please supply a command from the list above.')
    .strict()
    .wrap(yargs.terminalWidth())
    .argv;
}

module.exports = NgPackagesInstaller;
if (require.main === module) {
  main();
}