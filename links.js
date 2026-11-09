function repositoryUrl() {
  const configured = document.querySelector('meta[name="prism-repository"]').content.trim();
  if (/^https:\/\/github\.com\/[\w-]+\/[\w.-]+\/?$/.test(configured)) {
    return configured.replace(/\/$/, '');
  }

  const owner = location.hostname.match(/^([\w-]+)\.github\.io$/)?.[1];
  const project = location.pathname.split('/')[1];
  if (!owner || (project && !/^[\w.-]+$/.test(project))) return;
  return `https://github.com/${owner}/${project || location.hostname}`;
}

const repository = repositoryUrl();
if (repository) {
  const releases = `${repository}/releases`;
  const tag = document.querySelector('meta[name="prism-release-tag"]').content.trim();
  const version = /^[a-z0-9][\w.-]*$/i.test(tag) ? tag : null;
  const download = version ? `${releases}/download/${version}` : `${releases}/latest/download`;
  const destinations = {
    download: `${download}/PRISM-macOS-arm64.zip`,
    install: `${repository}/blob/main/README.md#install`,
    releases: version ? `${releases}/tag/${version}` : releases,
  };

  for (const link of document.querySelectorAll('[data-github-link]')) {
    link.href = destinations[link.dataset.githubLink];
    link.hidden = false;
  }
  document.querySelector('[data-local-preview]').hidden = true;
}
