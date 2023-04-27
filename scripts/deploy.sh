#!/bin/bash

set -e
set -x

function gitconfig() {
	git config user.name "qingwave"
	git config user.email "isguory@gmail.com"
}

script_dir=$(cd $(dirname $0); pwd)
dist_dir=${script_dir}/../dist

function deploy() {
    rm -rf ${dist_dir}
	npm run build
	cd ${dist_dir}
	git init
	git remote add origin git@github.com:qingwave/qingwave.github.io.git
	gitconfig
	git add . && git commit -m "update blog"
	git push --set-upstream origin master -f
}

deploy
