import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function codedError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code })
}

function pathEscape() {
  return codedError('path-escape', 'Repair path must stay inside root')
}

function escapes(root, target) {
  const relative = path.relative(root, target)
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

function resolveTarget(root, relative) {
  const realRoot = fs.realpathSync(root)
  let target = realRoot
  for (const part of relative.split(path.sep)) {
    target = path.join(target, part)
    // Inspect links even when their referent does not exist.
    const entry = fs.lstatSync(target, { throwIfNoEntry: false })
    if (entry?.isSymbolicLink()) {
      try {
        target = fs.realpathSync(target)
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ELOOP') throw pathEscape()
        throw error
      }
      if (escapes(realRoot, target)) throw pathEscape()
    }
  }
  return target
}

function saveBackup(target, basename, backupDir) {
  try {
    fs.mkdirSync(backupDir, { mode: 0o700 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  for (;;) {
    const backup = path.join(backupDir, `${randomUUID()}-${basename}`)
    try {
      fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL)
      return backup
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// Stage next to the destination so a failed write cannot truncate the old file
// and replacing a hard link cannot change bytes through another name.
function replaceFile(target, write, didReplace) {
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(target), '.repair-'))
  try {
    const staged = path.join(stagingDir, 'bytes')
    write(staged)
    fs.renameSync(staged, target)
    didReplace?.()
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true })
  }
}

export function repairWrite({ root, relPath, bytes, backupDir }) {
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
      typeof backupDir !== 'string' || !path.isAbsolute(backupDir) ||
      typeof relPath !== 'string' || path.isAbsolute(relPath) || relPath.startsWith('..')) {
    throw pathEscape()
  }
  const requestedPath = path.resolve(root, relPath)
  const relative = path.relative(root, requestedPath)
  if (!relative || escapes(root, requestedPath)) throw pathEscape()

  const target = resolveTarget(root, relative)
  const entry = fs.lstatSync(target, { throwIfNoEntry: false })
  if (entry && !entry.isFile()) throw new Error('Repair target must be a regular file')
  const created = !entry
  const expected = sha256(bytes)
  const backup = created ? null : saveBackup(target, path.basename(requestedPath), backupDir)
  let replaced = false

  function rollback(cause) {
    try {
      if (replaced) {
        if (created) fs.unlinkSync(target)
        else replaceFile(target, (staged) => fs.copyFileSync(backup, staged))
      }
    } catch (error) {
      throw codedError('verify-failed', 'Repair verification and rollback failed', new AggregateError([cause, error]))
    }
    throw codedError('verify-failed', 'Repair verification failed', cause)
  }

  let actual
  try {
    replaceFile(target, (staged) => {
      fs.writeFileSync(staged, bytes)
      if (entry) fs.chmodSync(staged, entry.mode & 0o777)
    }, () => { replaced = true })
    actual = sha256(fs.readFileSync(requestedPath))
  } catch (error) {
    rollback(error)
  }
  if (actual !== expected) rollback(new Error('Repair hash mismatch'))
  return { path: requestedPath, sha256: actual, backup, created }
}
