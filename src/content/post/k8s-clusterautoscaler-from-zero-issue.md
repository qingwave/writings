---
title: ClusterAutoScaler无法从零扩容
author: qinng
toc: true
comments: true
tags:
  - k8s
date: 2021-11-08 09:17:48
categories:
  - cloud
---

## 背景

最近在 AWS k8s 集群部署一个多 AZ 应用时，发现`cluster-autoscaler`无法正常`scale up`。

<!--more-->

通过反复测试发现，当`NodeGroup`的初始容量为 0 时（`minSize=0`）无法扩容，报错信息如下，当`NodeGrop`初始容量为 1 时（`minSize=1`）可以正常扩容。

```
Normal   NotTriggerScaleUp  18m                   cluster-autoscaler  pod didn't trigger scale-up (it wouldn't fit if a new node is added): 3 Insufficient cpu, 1 node(s) didn't match node selector, 1 max node group size reached, 12 Insufficient memory, 1 node(s) didn't match pod affinity/anti-affinity, 1 node(s) didn't match pod anti-affinity rules, 3 node(s) had taint, that the pod didn't tolerate
```

这个现象很有意思，跟着代码查看下究竟是哪里出问题了。

## 探究

`ClusterAutoScaler`主要扩容逻辑如下：

- 定期获取（默认 10s）所有`Pending` Pod，过滤出由于资源不足调度失败的 Pod
- 根据`NodeGroup`生成新 Node 模拟调度，如果可以调度则将新节点加入集群

根据现象猜测与生成`NodeTemplate`有关，否则不会造成两次情况调度结果不一致。
主要代码位于[utils.go#L42](https://github.com/kubernetes/autoscaler/blob/cluster-autoscaler-release-1.21/cluster-autoscaler/core/utils/utils.go#L42)

```go
// nodes 指当前集群中所有node
func GetNodeInfosForGroups(nodes []*apiv1.Node, nodeInfoCache map[string]*schedulerframework.NodeInfo, cloudProvider cloudprovider.CloudProvider, listers kube_util.ListerRegistry,
	daemonsets []*appsv1.DaemonSet, predicateChecker simulator.PredicateChecker, ignoredTaints taints.TaintKeySet) (map[string]*schedulerframework.NodeInfo, errors.AutoscalerError) {
	result := make(map[string]*schedulerframework.NodeInfo)
	seenGroups := make(map[string]bool)

  // 构建node与pod的映射
	podsForNodes, err := getPodsForNodes(listers)
	if err != nil {
		return map[string]*schedulerframework.NodeInfo{}, err
	}

	// processNode returns information whether the nodeTemplate was generated and if there was an error.
    // processNode 函数通过提供的node生成node模板
	processNode := func(node *apiv1.Node) (bool, string, errors.AutoscalerError) {
		nodeGroup, err := cloudProvider.NodeGroupForNode(node)
		if err != nil {
			return false, "", errors.ToAutoscalerError(errors.CloudProviderError, err)
		}
		if nodeGroup == nil || reflect.ValueOf(nodeGroup).IsNil() {
			return false, "", nil
		}
		id := nodeGroup.Id()
		// nodeGroup id不存在则将其添加到result中
		if _, found := result[id]; !found {
			// Build nodeInfo.
			// 根据当前node生成模板
			nodeInfo, err := simulator.BuildNodeInfoForNode(node, podsForNodes)
			if err != nil {
				return false, "", err
			}
			sanitizedNodeInfo, err := sanitizeNodeInfo(nodeInfo, id, ignoredTaints)
			if err != nil {
				return false, "", err
			}
			result[id] = sanitizedNodeInfo
			return true, id, nil
		}
		return false, "", nil
	}

	// 遍历所有node，如果通过node能获取到对应nodeGroup的模板，则添加到nodeInfoCache中
	for _, node := range nodes {
		// Broken nodes might have some stuff missing. Skipping.
		if !kube_util.IsNodeReadyAndSchedulable(node) {
			continue
		}
		added, id, typedErr := processNode(node)
		if typedErr != nil {
			return map[string]*schedulerframework.NodeInfo{}, typedErr
		}
		if added && nodeInfoCache != nil {
			if nodeInfoCopy, err := deepCopyNodeInfo(result[id]); err == nil {
				nodeInfoCache[id] = nodeInfoCopy
			}
		}
	}

	//如果不在cahce中，则通过nodeGroup生成模板
	for _, nodeGroup := range cloudProvider.NodeGroups() {
		id := nodeGroup.Id()
		seenGroups[id] = true
		if _, found := result[id]; found {
			continue
		}

		// No good template, check cache of previously running nodes.
		if nodeInfoCache != nil {
			if nodeInfo, found := nodeInfoCache[id]; found {
				if nodeInfoCopy, err := deepCopyNodeInfo(nodeInfo); err == nil {
					result[id] = nodeInfoCopy
					continue
				}
			}
		}

		// No good template, trying to generate one. This is called only if there are no
		// working nodes in the node groups. By default CA tries to use a real-world example.
		nodeInfo, err := GetNodeInfoFromTemplate(nodeGroup, daemonsets, predicateChecker, ignoredTaints)
		if err != nil {
			if err == cloudprovider.ErrNotImplemented {
				continue
			} else {
				klog.Errorf("Unable to build proper template node for %s: %v", id, err)
				return map[string]*schedulerframework.NodeInfo{}, errors.ToAutoscalerError(errors.CloudProviderError, err)
			}
		}
		result[id] = nodeInfo
	}

	// Remove invalid node groups from cache
	for id := range nodeInfoCache {
		if _, ok := seenGroups[id]; !ok {
			delete(nodeInfoCache, id)
		}
	}

	// 处理unready/unschedulable的节点
	for _, node := range nodes {
		// Allowing broken nodes
		if !kube_util.IsNodeReadyAndSchedulable(node) {
			added, _, typedErr := processNode(node)
			if typedErr != nil {
				return map[string]*schedulerframework.NodeInfo{}, typedErr
			}
			nodeGroup, err := cloudProvider.NodeGroupForNode(node)
			if err != nil {
				return map[string]*schedulerframework.NodeInfo{}, errors.ToAutoscalerError(
					errors.CloudProviderError, err)
			}
			if added {
				klog.Warningf("Built template for %s based on unready/unschedulable node %s", nodeGroup.Id(), node.Name)
			}
		}
	}

	return result, nil
}
```

方法`GetNodeInfosForGroups`生成模板的主要逻辑如下：

- 遍历集群中所有节点，节点有对应`nodeGroup`，则根据节点生成模板
- 其他`nodeGroup`则根据`nodeGroup`配置与`daemonset`信息生成模板

节点存在`nodeGroup`则根据`sanitizeNodeInfo`方法生成模板

```go
func BuildNodeInfoForNode(node *apiv1.Node, podsForNodes map[string][]*apiv1.Pod) (*schedulerframework.NodeInfo, errors.AutoscalerError) {
	// 获取当前节点daemonset与mirror pod
	requiredPods, err := getRequiredPodsForNode(node.Name, podsForNodes)
	if err != nil {
		return nil, err
	}
	// 生成node模板
	result := schedulerframework.NewNodeInfo(requiredPods...)
	if err := result.SetNode(node); err != nil {
		return nil, errors.ToAutoscalerError(errors.InternalError, err)
	}
	return result, nil
}

func filterRequiredPodsForNode(allPods []*apiv1.Pod) []*apiv1.Pod {
	var selectedPods []*apiv1.Pod

	for id, pod := range allPods {
		// Ignore pod in deletion phase
		if pod.DeletionTimestamp != nil {
			continue
		}

		if pod_util.IsMirrorPod(pod) || pod_util.IsDaemonSetPod(pod) {
			selectedPods = append(selectedPods, allPods[id])
		}
	}

	return selectedPods
}
```

根据 nodeGroup 生成模板调用`GetNodeInfoFromTemplate`方法，首先获取 noGroup 模板信息，再将 daemonset pod 信息加入 node

```go
func GetNodeInfoFromTemplate(nodeGroup cloudprovider.NodeGroup, daemonsets []*appsv1.DaemonSet, predicateChecker simulator.PredicateChecker, ignoredTaints taints.TaintKeySet) (*schedulerframework.NodeInfo, errors.AutoscalerError) {
	id := nodeGroup.Id()
	baseNodeInfo, err := nodeGroup.TemplateNodeInfo()
	if err != nil {
		return nil, errors.ToAutoscalerError(errors.CloudProviderError, err)
	}

	pods, err := daemonset.GetDaemonSetPodsForNode(baseNodeInfo, daemonsets, predicateChecker)
	if err != nil {
		return nil, errors.ToAutoscalerError(errors.InternalError, err)
	}
	for _, podInfo := range baseNodeInfo.Pods {
		pods = append(pods, podInfo.Pod)
	}
	fullNodeInfo := schedulerframework.NewNodeInfo(pods...)
	fullNodeInfo.SetNode(baseNodeInfo.Node())
	sanitizedNodeInfo, typedErr := sanitizeNodeInfo(fullNodeInfo, id, ignoredTaints)
	if typedErr != nil {
		return nil, typedErr
	}
	return sanitizedNodeInfo, nil
}
```

其中`nodeGroup.TemplateNodeInfo`方法是每个云供应商提供的，`AWS`相关代码位于[aws_cloud_provider.go#L100](https://github.com/kubernetes/autoscaler/blob/55476293b3cb1e37e33680cefe01e7b34170a712/cluster-autoscaler/cloudprovider/aws/aws_cloud_provider.go#L100)

```go
// TemplateNodeInfo returns a node template for this node group.
func (ng *AwsNodeGroup) TemplateNodeInfo() (*schedulerframework.NodeInfo, error) {
	// 获取模板
	template, err := ng.awsManager.getAsgTemplate(ng.asg)
	if err != nil {
		return nil, err
	}

	// 生成node
	node, err := ng.awsManager.buildNodeFromTemplate(ng.asg, template)
	if err != nil {
		return nil, err
	}

	nodeInfo := schedulerframework.NewNodeInfo(cloudprovider.BuildKubeProxy(ng.asg.Name))
	nodeInfo.SetNode(node)
	return nodeInfo, nil
}

func (m *AwsManager) getAsgTemplate(asg *asg) (*asgTemplate, error) {
	...
	instanceTypeName, err := m.buildInstanceType(asg)
	if err != nil {
		return nil, err
	}
	// 根据instanceTypeName获取模板
	if t, ok := m.instanceTypes[instanceTypeName]; ok {
		return &asgTemplate{
			InstanceType: t,
			Region:       region,
			Zone:         az,
			Tags:         asg.Tags,
		}, nil
	}
	return nil, fmt.Errorf("ASG %q uses the unknown EC2 instance type %q", asg.Name, instanceTypeName)
}
```

在`AWS`通过`nodeGroup`生成节点模板，是根据[ec2_instance_types.go](https://github.com/kubernetes/autoscaler/blob/55476293b3cb1e37e33680cefe01e7b34170a712/cluster-autoscaler/cloudprovider/aws/ec2_instance_types.go#L30)文件中的信息来生成的，如下`c5d.large`为 ec2 类型名称，CPU 为 2，内存为`4G`i

```go
	"c5d.large": {
		InstanceType: "c5d.large",
		VCPU:         2,
		MemoryMb:     4096,
		GPU:          0,
	},
```

而在我们的环境中，由于成本原因实际使用的`c5d.large`内存是`16Gi`。当 nodeGroup 初始节点为 0 时，根据 ec2 类型生成的节点是`4Gi`内存；而当初始节点为 1 时，集群中已经存在对应 nodeGroup 的节点，则通过已存在节点生成模板的内存为`16Gi`，**内存不足**才导致调度失败，我们也验证了调小 pod 申请的内存确实能够正常扩容。

一个简单的解决办法是将初始节点设置为 1，另外可以将特殊类型添加到配置文件中，则可以正常工作。但根本原因是在`AWS`中无法正常感知节点资源的动态变化。

## 总结

在`AWS`中通过静态文件来获取节点资源信息，当实际生产中与文件不一致时，会造成`ClusterAutoScaler`无法按照预期工作。`ClusterAutoScaler`大大减少了运维工作，无需时时关心资源申请量，但只有了解其内部逻辑，才能更好的应用于生产。
