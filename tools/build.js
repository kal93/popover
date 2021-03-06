/**
 * Largely based on the build scripts from https://github.com/angular/angularfire2
 * and https://github.com/angular/material2
 */
const { sync } = require('glob');
const { rollup } = require('rollup');
const { forkJoin, from: observableFrom } = require('rxjs');
const { tap, switchMap } = require('rxjs/operators');
const { readFileSync, writeFileSync } = require('fs-extra');
const { join } = require('path');
const resolve = require('rollup-plugin-node-resolve');
const sourcemaps = require('rollup-plugin-sourcemaps');
const sass = require('node-sass');

const pkg = require(join(process.cwd(), 'package.json'));
const GLOBALS = require('./utils/rollup-globals');
const copyFiles = require('./utils/copy-files');
const minifySources = require('./utils/minify-sources');
const inlineResources = require('./utils/inline-resources');
const spawn$ = require('./utils/rx-spawn');

// Directory constants
const BASE_DIR = process.cwd();
const LIB_DIR = join(BASE_DIR, 'src/lib');
const BUILD_DIR = join(BASE_DIR, '.ng_build');
const DIST_DIR = join(BASE_DIR, 'dist/lib');

// Map versions across packages
const VERSIONS = {
  ANGULAR_VERSION: pkg.devDependencies['@angular/core'],
  CDK_VERSION: pkg.devDependencies['@angular/cdk'],
  POPOVER_VERSION: pkg.version,
};

// Constants for running typescript commands
const NGC = 'node_modules/.bin/ngc';
const NGC_ARGS = [`-p`, join(LIB_DIR, 'tsconfig.lib.json')];
const NGC_ARGS_ES5 = NGC_ARGS.concat(
  ['--outDir', join(BUILD_DIR, 'es5')],
  ['--target', 'ES5']
);

/** Replaces the version placeholders in the specified package. */
function replacePackageVersions(packagePath, versions) {
  // Read package
  let package = readFileSync(packagePath, 'utf-8');

  // Replace
  const regexs = Object
    .keys(versions)
    .map(key => ({ expression: new RegExp(key, 'g'), key, val: versions[key] }));
  regexs.forEach(r => package = package.replace(r.expression, r.val));

  // Write back
  writeFileSync(packagePath, package);
}

/** Replaces any old property of the package. */
function replacePackageProperties(packagePath, properties) {
  // Read and parse
  const package = JSON.parse(readFileSync(packagePath, 'utf-8'));

  // Update properties
  properties.forEach(prop => package[prop] = pkg[prop]);;

  // Write back
  writeFileSync(packagePath, JSON.stringify(package, null, 2));
}

function rollup$(input, output, format) {
  const inputOptions = {
    input: input,
    external: Object.keys(GLOBALS),
    plugins: [resolve(), sourcemaps()],
  };

  const outputOptions = {
    file: output,
    format: format,
    name: 'popover',
    globals: GLOBALS,
    sourcemap: true,
  };

  return observableFrom(
    rollup(inputOptions)
      .then(bundle => bundle.write(outputOptions))
  );
}


/** Build the library and copy over files. */
function buildLibrary$(globals, versions) {
  // Compile to build folder for es2015 and es5
  return forkJoin(
      spawn$(NGC, NGC_ARGS),
      spawn$(NGC, NGC_ARGS_ES5),
    )
    .pipe(
      tap(() => {
        // Copy styles and markup
        ['es2015', 'es5']
          .forEach(dir => copyFiles(LIB_DIR, '**/*.+(scss|css|html)', join(BUILD_DIR, dir)));

        // Compile sass in build directory
        sync(join(BUILD_DIR, '**/*.scss')).forEach(path => {
          const sassString = sass.renderSync({ file: path }).css.toString();
          const newPath = path.slice(0, -4) + 'css';
          writeFileSync(newPath, sassString, 'utf-8');
        });

        // Inline resources
        inlineResources(BUILD_DIR, LIB_DIR);
      }),
      // Rollup
      switchMap(() => forkJoin(
        rollup$(join(BUILD_DIR, 'es2015/popover.js'), join(DIST_DIR, '@ncstate/sat-popover.js'), 'es'),
        rollup$(join(BUILD_DIR, 'es5/popover.js'), join(DIST_DIR, '@ncstate/sat-popover.es5.js'), 'es'),
        rollup$(join(BUILD_DIR, 'es5/popover.js'), join(DIST_DIR, 'bundles/sat-popover.umd.js'), 'umd')
      )),
      tap(() => {
        // Minify umd bundle
        minifySources(
          join(DIST_DIR, 'bundles/sat-popover.umd.js'),
          join(DIST_DIR, 'bundles/sat-popover.umd.min.js')
        );

        // Copy typings/metadata/readme to dist directory
        copyFiles(join(BUILD_DIR, 'es2015'), '**/*.+(d.ts|metadata.json)', DIST_DIR);
        copyFiles(BASE_DIR, 'README.md', DIST_DIR);
        copyFiles(LIB_DIR, 'package.json', DIST_DIR);

        // Replace package versions and copy to dist directory
        replacePackageVersions(join(DIST_DIR, 'package.json'), versions);
        replacePackageProperties(join(DIST_DIR, 'package.json'),
            ['keywords', 'repository', 'bugs', 'homepage']);
      })
    );
}

// Kick it off
buildLibrary$(GLOBALS, VERSIONS)
  .pipe(
    switchMap(() => forkJoin(spawn$('npm', ['run', 'copylib'])))
  )
  .subscribe(
    undefined,
    err => console.error('err', err),
    () => console.log('\ncomplete')
  );
