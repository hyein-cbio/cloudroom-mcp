import { GatewayError } from './cli.mjs';
import { repositoryFromRemote } from './github.mjs';
import { PERSONAL_PROJECT_ID, projectId } from './schemas.mjs';

export function createProjects(config, run, withLock, registerGithubRepo) {
  function allowed(repo) {
    if (!config.allowedGithubRepos.has(repo)) {
      throw new GatewayError('repository_not_allowed', 'GitHub repository is not allowlisted by this server',
        { github_repo: repo, outcome_unknown: false });
    }
  }

  async function verify(id, signal, expectedRepo) {
    if (id === PERSONAL_PROJECT_ID) {
      if (expectedRepo) throw new GatewayError('repository_mismatch', 'A repository project resolved to Personal', { outcome_unknown: false });
      return null;
    }
    if (!projectId.safeParse(id).success) throw new GatewayError('invalid_cli_response', 'Invalid internal project ID');
    const project = await run(['project', 'show', id, '--json'], { signal });
    if (!project || project.id !== id) throw new GatewayError('invalid_cli_response', 'Unexpected project metadata');
    const repo = repositoryFromRemote(project.gitRemoteUrl);
    if (!repo || expectedRepo && repo !== expectedRepo) {
      throw new GatewayError('repository_mismatch', 'Project does not reference the expected GitHub repository', { outcome_unknown: false });
    }
    allowed(repo);
    return repo;
  }

  async function resolve(repo, signal) {
    if (repo === null) return { projectId: PERSONAL_PROJECT_ID, githubRepo: null, registrationUsed: false };
    allowed(repo);
    return withLock('github:' + repo, async () => {
      const projects = await run(['project', 'list', '--json'], { signal });
      if (!Array.isArray(projects)) throw new GatewayError('invalid_cli_response', 'Expected a project list');
      const matches = projects.filter(project => repositoryFromRemote(project?.gitRemoteUrl) === repo);
      if (matches.length > 1) throw new GatewayError('ambiguous_repository',
        'Multiple Cloudroom projects reference this GitHub repository; resolve the duplicate projects first',
        { github_repo: repo, outcome_unknown: false });
      const registrationUsed = matches.length === 0;
      const id = registrationUsed ? await registerGithubRepo(repo, { signal }) : matches[0].id;
      try { await verify(id, signal, repo); }
      catch (error) {
        if (error instanceof GatewayError) error.details = {
          ...error.details, repository_registration_used: registrationUsed, returned_project_id: id,
        };
        throw error;
      }
      return { projectId: id, githubRepo: repo, registrationUsed };
    });
  }

  return { resolve, verify };
}
