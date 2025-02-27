import { UploaderArgs, UploaderInputs } from './types'

import zlib from 'zlib'
import { version } from '../package.json'
import { detectProvider } from './helpers/provider'
import * as webHelpers from './helpers/web'
import { info, logError, UploadLogger } from './helpers/logger'
import { getToken } from './helpers/token'
import {
  cleanCoverageFilePaths,
  coverageFilePatterns,
  fetchGitRoot,
  fileHeader,
  filterFilesAgainstBlockList,
  getBlocklist,
  getCoverageFiles,
  getFileListing,
  getFilePath,
  MARKER_ENV_END,
  MARKER_FILE_END,
  MARKER_NETWORK_END,
  readCoverageFile,
  removeFile,
} from './helpers/files'
import { generateCoveragePyFile } from './helpers/coveragepy'
import { generateGcovCoverageFiles } from './helpers/gcov'
import { generateXcodeCoverageFiles } from './helpers/xcode'
import { argAsArray } from './helpers/util'

/**
 *
 * @param {string} uploadHost
 * @param {string} token
 * @param {string} query
 * @param {string} uploadFile
 * @param {string} source
 */
function dryRun(
  uploadHost: string,
  token: string,
  query: string,
  uploadFile: string,
  source: string,
) {
  info('==> Dumping upload file (no upload)')
  info(
    `${uploadHost}/upload/v4?package=${webHelpers.getPackage(
      source,
    )}&token=${token}&${query}`,
  )
  info(uploadFile)
}

/**
 *
 * @param {Object} args
 * @param {string} args.build Specify the build number manually
 * @param {string} args.branch Specify the branch manually
 * @param {string} args.dir Directory to search for coverage reports.
 * @param {string} args.env Specify environment variables to be included with this build
 * @param {string} args.sha Specify the commit SHA mannually
 * @param {string} args.file Target file(s) to upload
 * @param {string} args.flags Flag the upload to group coverage metrics
 * @param {string} args.name Custom defined name of the upload. Visible in Codecov UI
 * @param {string} args.networkFilter Specify a filter on the files listed in the network section of the Codecov report. Useful for upload-specific path fixing
 * @param {string} args.networkPrefix Specify a prefix on files listed in the network section of the Codecov report. Useful to help resolve path fixing
 * @param {string} args.parent The commit SHA of the parent for which you are uploading coverage.
 * @param {string} args.pr Specify the pull request number mannually
 * @param {string} args.token Codecov upload token
 * @param {string} args.tag Specify the git tag
 * @param {boolean} args.verbose Run with verbose logging
 * @param {string} args.rootDir Specify the project root directory when not in a git repo
 * @param {boolean} args.nonZero Should errors exit with a non-zero (default: false)
 * @param {boolean} args.dryRun Don't upload files to Codecov
 * @param {string} args.slug Specify the slug manually
 * @param {string} args.url Change the upload host (Enterprise use)
 * @param {boolean} args.clean Move discovered coverage reports to the trash
 * @param {string} args.feature Toggle features
 * @param {string} args.source Track wrappers of the uploader
 */
export async function main(
  args: UploaderArgs,
): Promise<void | Record<string, unknown>> {

  if (args.verbose) {
    UploadLogger.setLogLevel('verbose')
  }

  // Did user asking for changelog?
  if (args.changelog) {
    webHelpers.displayChangelog()
    return
  }

  /*
  Step 1: validate and sanitize inputs
  Step 2: detect if we are in a git repo
  Step 3: sanitize and set token
  Step 4: get network (file listing)
  Step 5: select coverage files (search or specify)
  Step 6: generate upload file
  Step 7: determine CI provider
  Step 8: either upload or dry-run
  */

  // #region == Step 1: validate and sanitize inputs
  // TODO: clean and sanitize envs and args
  const envs = process.env
  // args
  const inputs: UploaderInputs = { args, environment: envs }

  let uploadHost: string
  if (args.url) {
    uploadHost = args.url
  } else {
    uploadHost = 'https://codecov.io'
  }

  info(generateHeader(getVersion()))

  // #endregion
  // #region == Step 2: detect if we are in a git repo
  const projectRoot = args.rootDir || fetchGitRoot()
  if (projectRoot === '') {
    info(
      '=> No git repo detected. Please use the -R flag if the below detected directory is not correct.',
    )
  }

  info(`=> Project root located at: ${projectRoot}`)

  // #endregion
  // #region == Step 3: sanitize and set token
  const token = await getToken(inputs, projectRoot)
  if (token === '') {
    info('-> No token specified or token is empty')
  }

  // #endregion
  // #region == Step 4: get network
  const uploadFileChunks: Buffer[] = []

  if (!args.feature || args.feature.split(',').includes('network') === false) {
    UploadLogger.verbose('Start of network processing...')
    let fileListing = ''
    try {
      fileListing = await getFileListing(projectRoot, args)
    } catch (error) {
      throw new Error(`Error getting file listing: ${error}`)
    }

    uploadFileChunks.push(Buffer.from(fileListing))
    uploadFileChunks.push(Buffer.from(MARKER_NETWORK_END))
  }

  // #endregion
  // #region == Step 5: select coverage files (search or specify)

  let requestedPaths: string[] = []

  // Look for files

  if (args.gcov) {
    UploadLogger.verbose('Running gcov...')
    const gcovInclude: string[] = argAsArray(args.gcovInclude)
    const gcovIgnore: string[] = argAsArray(args.gcovIgnore)
    const gcovArgs: string[] = argAsArray(args.gcovArgs)
    const gcovLogs = await generateGcovCoverageFiles(projectRoot, gcovInclude, gcovIgnore, gcovArgs)
    UploadLogger.verbose(`${gcovLogs}`)
  }

  if (args.xcode) {
    if (!args.xcodeArchivePath) {
      throw new Error('Please specify xcodeArchivePath to run the Codecov uploader with xcode support')
    } else {
      const xcodeArchivePath: string = args.xcodeArchivePath
      const xcodeLogs = await generateXcodeCoverageFiles(xcodeArchivePath)
      UploadLogger.verbose(`${xcodeLogs}`)
    }
  }

  let coverageFilePaths: string[] = []
  requestedPaths = argAsArray(args.file)

  try {
    const coveragePyLogs = await generateCoveragePyFile(projectRoot, requestedPaths)
    UploadLogger.verbose(`${coveragePyLogs}`)
  } catch (error) {
    UploadLogger.verbose(`Skipping coveragepy conversion: ${error}`)
  }

  coverageFilePaths = requestedPaths

  if (!args.feature || args.feature.split(',').includes('search') === false) {
    info('Searching for coverage files...')
    const isNegated = (path: string) => path.startsWith('!')
    coverageFilePaths = coverageFilePaths.concat(await getCoverageFiles(
      args.dir || projectRoot,
      (() => {
        const numOfNegatedPaths = coverageFilePaths.filter(isNegated).length

        if (coverageFilePaths.length > numOfNegatedPaths) {
          return coverageFilePaths
        } else {
          return coverageFilePaths.concat(coverageFilePatterns())
        }
      })(),
    ))

    // Generate what the file listing would be after the blocklist is applied

    let coverageFilePathsAfterFilter = coverageFilePaths

    if (coverageFilePaths.length > 0) {
      coverageFilePathsAfterFilter = filterFilesAgainstBlockList(coverageFilePaths, getBlocklist())
    }




    // If args.file was passed, emit warning for 'filtered' filess

    if (requestedPaths.length > 0) {
      if (coverageFilePathsAfterFilter.length !== requestedPaths.length) {
        info('Warning: Some files passed via the -f flag would normally be excluded from search.')
        info('If Codecov encounters issues processing your reports, please review https://docs.codecov.com/docs/supported-report-formats')
      }
    } else {
      // Overwrite coverageFilePaths with coverageFilePathsAfterFilter
      info('Warning: Some files located via search were excluded from upload.')
      info('If Codecov did not locate your files, please review https://docs.codecov.com/docs/supported-report-formats')

      coverageFilePaths = coverageFilePathsAfterFilter
    }

  }

  let coverageFilePathsThatExist: string[] = []

  if (coverageFilePaths.length > 0) {
    coverageFilePathsThatExist = cleanCoverageFilePaths(args.dir || projectRoot, coverageFilePaths)
  }

  if (coverageFilePathsThatExist.length > 0) {
    info(`=> Found ${coverageFilePathsThatExist.length} possible coverage files:\n  ` +
    coverageFilePathsThatExist.join('\n  '))
  } else {
    const noFilesError = args.file ?
      'No coverage files found, exiting.' :
      'No coverage files located, please try use `-f`, or change the project root with `-R`'
    throw new Error(noFilesError)
  }

  UploadLogger.verbose('End of network processing')
  // #endregion
  // #region == Step 6: generate upload file
  // TODO: capture envs

  // Get coverage report contents
  let coverageFileAdded = false
  for (const coverageFile of coverageFilePathsThatExist) {
    let fileContents
    try {
      info(`Processing ${getFilePath(args.dir || projectRoot, coverageFile)}...`),
        (fileContents = await readCoverageFile(
          args.dir || projectRoot,
          coverageFile,
        ))
    } catch (err) {
      info(`Could not read coverage file (${coverageFile}): ${err}`)
      continue
    }

    uploadFileChunks.push(Buffer.from(fileHeader(coverageFile)))
    uploadFileChunks.push(Buffer.from(fileContents))
    uploadFileChunks.push(Buffer.from(MARKER_FILE_END))
    coverageFileAdded = true
  }
  if (!coverageFileAdded) {
    throw new Error( 'No coverage files could be found to upload, exiting.')
  }

  // Cleanup
  if (args.clean) {
    for (const coverageFile of coverageFilePathsThatExist) {
      removeFile(args.dir || projectRoot, coverageFile)
    }
  }

  // Environment variables
  if (args.env || envs.CODECOV_ENV) {
    const environmentVars = args.env || envs.CODECOV_ENV || ''
    const vars = environmentVars
      .split(',')
      .filter(Boolean)
      .map(evar => `${evar}=${process.env[evar] || ''}\n`)
      .join('')
    uploadFileChunks.push(Buffer.from(vars))
    uploadFileChunks.push(Buffer.from(MARKER_ENV_END))
  }

  const uploadFile = Buffer.concat(uploadFileChunks)
  const gzippedFile = zlib.gzipSync(uploadFile)

  // #endregion
  // #region == Step 7: determine CI provider

  const hasToken = token !== ''

  const serviceParams = detectProvider(inputs, hasToken)

  // #endregion
  // #region == Step 8: either upload or dry-run

  const buildParams = webHelpers.populateBuildParams(inputs, serviceParams)

  UploadLogger.verbose('Using the following upload parameters:')
  for (const parameter in buildParams) {
    UploadLogger.verbose(`${parameter}`)
  }

  if (buildParams.slug !== '' && !buildParams.slug?.match(/\//)) {
    logError(`Slug must follow the format of "<owner>/<repo>" or be blank. We detected "${buildParams.slug}"`)
  }

  const query = webHelpers.generateQuery(buildParams)

  if (args.dryRun) {
    dryRun(uploadHost, token, query, uploadFile.toString(), args.source || '')
    return
  }

  info(
    `Pinging Codecov: ${uploadHost}/upload/v4?package=${webHelpers.getPackage(
      args.source || '',
    )}&token=*******&${query}`,
  )
  UploadLogger.verbose(`Passed token was ${token.length} characters long`)
  try {
    UploadLogger.verbose(
      `${uploadHost}/upload/v4?package=${webHelpers.getPackage(
        args.source || '',
      )}&${query}
        Content-Type: 'text/plain'
        Content-Encoding: 'gzip'
        X-Reduced-Redundancy: 'false'`
    )

    const postURL = new URL(uploadHost)

    const putAndResultUrlPair = await webHelpers.uploadToCodecovPOST(
      postURL,
      token,
      query,
      args.source || '',
      args,
    )

    const postResults = webHelpers.parsePOSTResults(putAndResultUrlPair)

    UploadLogger.verbose(`Returned upload url: ${postResults.putURL}`)

    const statusAndResultPair = await webHelpers.uploadToCodecovPUT(
      postResults,
      gzippedFile,
      args,
    )
    info(JSON.stringify(statusAndResultPair))
    return {resultURL: statusAndResultPair.resultURL.href, status: statusAndResultPair.status }
  } catch (error) {
    throw new Error(`Error uploading to ${uploadHost}: ${error}`)
  }
  // #endregion
}

/**
 *
 * @param {string} version
 * @returns {string}
 */
export function generateHeader(version: string): string {
  return `
     _____          _
    / ____|        | |
   | |     ___   __| | ___  ___ _____   __
   | |    / _ \\ / _\` |/ _ \\/ __/ _ \\ \\ / /
   | |___| (_) | (_| |  __/ (_| (_) \\ V /
    \\_____\\___/ \\__,_|\\___|\\___\\___/ \\_/

  Codecov report uploader ${version}`
}

export function getVersion(): string {
  return version
}

export { logError, info, verbose } from './helpers/logger'
